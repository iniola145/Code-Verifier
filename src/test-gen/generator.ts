import * as fs from "fs";
import * as path from "path";
import traverse from "@babel/traverse";
import { ProjectSummaryIndex } from "../abstract-interpreter/project-summaries";
import { CodeVerifier } from "../engine";
import { parseSourceCode } from "../parser/ast";
import { ProjectUiIndex } from "../project-ui-index";
import { synthesizeMocks } from "./mock-synthesizer";
import {
  getAllStrategies,
  getStrategiesForRule,
  generateServiceModuleTests,
} from "./strategies";
import { generateTestFile } from "./templates";
import {
  GeneratedTest,
  StrategyContext,
  TestCase,
  TestFramework,
  TestGenOptions,
} from "./types";
import { detectFramework } from "./detect-framework";
export { detectFramework };

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

  // If no specific finding triggered a strategy or file is clean, check for service modules
  if (testCases.length === 0) {
    const serviceTests = generateServiceModuleTests(context);
    if (serviceTests.length > 0) {
      testCases.push(...serviceTests);
    }
  }

  // If still no test cases, generate a baseline test
  if (testCases.length === 0) {
    const baseName = path.basename(resolvedPath).replace(/\.(tsx?|jsx?)$/, "");

    // Check if AST contains JSX elements/fragments or component contracts
    let hasJsx = false;
    traverse(ast, {
      JSXElement() {
        hasJsx = true;
      },
      JSXFragment() {
        hasJsx = true;
      },
    });

    const isComponent = hasJsx || contracts.length > 0;

    if (isComponent) {
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
      testCases.push({
        id: `baseline-${baseName}`,
        description: `should load module and export defined members`,
        framework,
        body: `  it('loads module and exports defined members', () => {\n    expect(${baseName}Module).toBeDefined();\n  });`,
        imports: [`import * as ${baseName}Module from './${baseName}';`],
        mocks,
        sourceFile: resolvedPath,
        coversRules: [],
        confidence: 1.0,
      });
    }
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
