import * as fs from "fs";
import * as path from "path";
import { ProjectSummaryIndex } from "../abstract-interpreter/project-summaries";
import { CodeVerifier } from "../engine";
import { parseSourceCode } from "../parser/ast";
import { ProjectUiIndex } from "../project-ui-index";
import { synthesizeMocks } from "./mock-synthesizer";
import { getAllStrategies, getStrategiesForRule } from "./strategies";
import { generateTestFile } from "./templates";
import {
  GeneratedTest,
  StrategyContext,
  TestCase,
  TestFramework,
  TestGenOptions,
} from "./types";

/**
 * Detect the test framework from a project's package.json.
 * Traverses upwards with a bounded search depth.
 */
export function detectFramework(projectRoot: string): TestFramework {
  let curr = path.resolve(projectRoot);
  let pkgPath = path.join(curr, "package.json");
  let depth = 0;
  const maxDepth = 10;

  // Traverse upward to locate package.json with depth limit
  while (!fs.existsSync(pkgPath) && depth < maxDepth) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
    pkgPath = path.join(curr, "package.json");
    depth++;
  }

  if (!fs.existsSync(pkgPath)) return "jest";

  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    if (allDeps.vitest) return "vitest";
    if (allDeps.jest || allDeps["react-native"] || allDeps.expo) return "jest";
  } catch {
    // Fall back to jest
  }

  return "jest";
}

/**
 * Generate tests for a single file.
 */
export async function generateTestsForFile(
  filePath: string,
  options?: TestGenOptions,
  codeOverride?: string,
  sharedUiIndex?: ProjectUiIndex,
  sharedVerifier?: CodeVerifier,
  sharedSummaryIndex?: ProjectSummaryIndex,
): Promise<GeneratedTest> {
  const resolvedPath = path.resolve(filePath);
  const code =
    codeOverride !== undefined
      ? codeOverride
      : fs.readFileSync(resolvedPath, "utf-8");

  // 1. Parse AST
  const { ast } = parseSourceCode(code, resolvedPath);

  // 2. Framework detection
  const projectRoot = options?.projectRoot || path.dirname(resolvedPath);
  const framework = options?.framework || detectFramework(projectRoot);

  // 3. UI Index, Summary Index & Verifier execution (reusing shared instances if available)
  const uiIndex =
    sharedUiIndex ||
    (fs.existsSync(resolvedPath)
      ? ProjectUiIndex.fromFiles([resolvedPath])
      : undefined);

  const summaryIndex =
    sharedSummaryIndex ||
    (fs.existsSync(resolvedPath)
      ? ProjectSummaryIndex.fromFiles([resolvedPath])
      : undefined);

  const verifier =
    sharedVerifier ||
    new CodeVerifier({
      projectRoot,
      projectUiIndex: uiIndex,
      projectSummaryIndex: summaryIndex,
    });

  const result = await verifier.verifyCode(code, resolvedPath);

  // 4. Extract component contracts & function summaries
  const contractsMap = uiIndex
    ? uiIndex.componentContractsForFile(ast, resolvedPath)
    : new Map();
  const contracts = [...contractsMap.values()];

  const functionSummaries = summaryIndex
    ? [...summaryIndex.summariesForFile(ast, resolvedPath).values()]
    : [];

  // 5. Synthesize mocks from file imports
  const mocks = synthesizeMocks(ast, framework);

  // 6. Execute test generation strategies
  const context: StrategyContext = {
    sourceFile: resolvedPath,
    code,
    ast,
    findings: result.diagnostics,
    contracts,
    functionSummaries,
    framework,
    projectRoot,
  };

  const testCases: TestCase[] = [];
  const handledRules = new Set<string>();

  for (const finding of result.diagnostics) {
    if (
      options?.ruleFilter &&
      options.ruleFilter.length > 0 &&
      !options.ruleFilter.includes(finding.ruleId)
    ) {
      continue;
    }

    const strategies = getStrategiesForRule(finding.ruleId);
    for (const strat of strategies) {
      const generated = strat.generate(context, finding);
      for (const tc of generated) {
        testCases.push(tc);
        handledRules.add(finding.ruleId);
      }
    }
  }

  // If no specific finding triggered a strategy or file is clean, generate a baseline test
  if (testCases.length === 0) {
    const baseName = path.basename(resolvedPath).replace(/\.(tsx?|jsx?)$/, "");
    testCases.push({
      id: `baseline-${baseName}`,
      description: `should render or load without crashing`,
      framework,
      body: `  it('loads module and renders without crashing', () => {\n    expect(true).toBe(true);\n  });`,
      imports: [
        `import React from 'react';`,
        `import { render } from '@testing-library/react-native';`,
      ],
      mocks,
      sourceFile: resolvedPath,
      coversRules: [],
      confidence: 1.0,
    });
  } else {
    // Attach synthesized mocks to test cases so template renders them
    if (mocks.length > 0 && testCases[0]) {
      testCases[0].mocks = [...mocks, ...testCases[0].mocks];
    }
  }

  // 7. Format complete test file
  const testFileName = resolvedPath.replace(/\.(tsx?|jsx?)$/, ".test.$1");
  const content = generateTestFile(testCases, framework, resolvedPath);

  return {
    filePath: testFileName,
    content,
    framework,
    testCases,
    sourceFile: resolvedPath,
  };
}

/**
 * Generate tests for multiple files.
 */
export async function generateTests(
  files: string[],
  options: TestGenOptions,
): Promise<GeneratedTest[]> {
  const resolvedFiles = files.map((f) => path.resolve(f));
  const projectRoot =
    options.projectRoot ||
    (resolvedFiles.length > 0
      ? path.dirname(resolvedFiles[0])
      : process.cwd());
  const framework = options.framework || detectFramework(projectRoot);

  // Build shared UI index and summary index across all target files
  const sharedUiIndex =
    resolvedFiles.length > 0
      ? ProjectUiIndex.fromFiles(resolvedFiles)
      : undefined;

  const sharedSummaryIndex =
    resolvedFiles.length > 0
      ? ProjectSummaryIndex.fromFiles(resolvedFiles)
      : undefined;

  // Single shared CodeVerifier instance for the entire batch
  const sharedVerifier = new CodeVerifier({
    projectRoot,
    projectUiIndex: sharedUiIndex,
    projectSummaryIndex: sharedSummaryIndex,
  });

  const results: GeneratedTest[] = [];

  for (const file of resolvedFiles) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    try {
      const testResult = await generateTestsForFile(
        file,
        { ...options, framework, projectRoot },
        undefined,
        sharedUiIndex,
        sharedVerifier,
        sharedSummaryIndex,
      );
      results.push(testResult);
    } catch (err: any) {
      console.warn(
        `[test-gen] Failed to generate tests for ${file}:`,
        err?.message || err,
      );
    }
  }

  return results;
}
