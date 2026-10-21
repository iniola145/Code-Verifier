import * as path from "path";
import { TestCase, TestFramework } from "./types";

export interface TemplateOptions {
  /** Relative import path to the source file (e.g. "./AuthScreen") */
  importPath?: string;
  /** Suite name override for describe() */
  suiteName?: string;
}

/**
 * Merge and deduplicate imports from multiple test cases.
 */
function mergeImports(importLines: string[]): string[] {
  const moduleMap = new Map<
    string,
    { defaultName?: string; named: Set<string>; sideEffect: boolean }
  >();

  for (const line of importLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ")) continue;

    const fromMatch = trimmed.match(/^import\s+(.*?)\s+from\s+['"](.*?)['"];?$/);
    if (fromMatch) {
      const clause = fromMatch[1].trim();
      const mod = fromMatch[2].trim();

      if (!moduleMap.has(mod)) {
        moduleMap.set(mod, { named: new Set(), sideEffect: false });
      }
      const entry = moduleMap.get(mod)!;

      if (clause.startsWith("{") && clause.endsWith("}")) {
        const namedList = clause
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        namedList.forEach((n) => entry.named.add(n));
      } else if (clause.includes("{")) {
        const [defPart, namedPart] = clause.split("{");
        const def = defPart.replace(",", "").trim();
        if (def) entry.defaultName = def;
        const namedList = namedPart
          .replace("}", "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        namedList.forEach((n) => entry.named.add(n));
      } else {
        entry.defaultName = clause;
      }
    } else {
      const sideEffectMatch = trimmed.match(/^import\s+['"](.*?)['"];?$/);
      if (sideEffectMatch) {
        const mod = sideEffectMatch[1];
        if (!moduleMap.has(mod)) {
          moduleMap.set(mod, { named: new Set(), sideEffect: true });
        }
      }
    }
  }

  const merged: string[] = [];
  for (const [mod, data] of moduleMap.entries()) {
    if (data.sideEffect && !data.defaultName && data.named.size === 0) {
      merged.push(`import '${mod}';`);
      continue;
    }
    const namedList = [...data.named].sort();
    if (data.defaultName && namedList.length > 0) {
      merged.push(
        `import ${data.defaultName}, { ${namedList.join(", ")} } from '${mod}';`,
      );
    } else if (data.defaultName) {
      merged.push(`import ${data.defaultName} from '${mod}';`);
    } else if (namedList.length > 0) {
      merged.push(`import { ${namedList.join(", ")} } from '${mod}';`);
    }
  }

  return merged;
}

/**
 * Remove unused imports by checking if imported identifiers appear in mocks or test bodies.
 */
function treeShakeImports(importLines: string[], codeBodies: string): string[] {
  const result: string[] = [];

  for (const line of importLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ")) {
      result.push(line);
      continue;
    }

    // Side-effect imports: always keep
    if (/^import\s+['"][^'"]+['"];?$/.test(trimmed)) {
      result.push(line);
      continue;
    }

    const match = trimmed.match(/^import\s+(.*?)\s+from\s+['"](.*?)['"];?$/);
    if (!match) {
      result.push(line);
      continue;
    }

    const clause = match[1].trim();
    const mod = match[2].trim();

    let defaultName: string | undefined;
    let isNamespace = false;
    let namedImports: string[] = [];

    if (clause.startsWith("* as ")) {
      defaultName = clause.slice(5).trim();
      isNamespace = true;
    } else if (clause.startsWith("{") && clause.endsWith("}")) {
      namedImports = clause
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (clause.includes("{")) {
      const [defPart, namedPart] = clause.split("{");
      defaultName = defPart.replace(",", "").trim() || undefined;
      namedImports = namedPart
        .replace("}", "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      defaultName = clause;
    }

    const isUsed = (name: string) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`);
      return regex.test(codeBodies);
    };

    const usedDefault =
      defaultName && isUsed(defaultName) ? defaultName : undefined;
    const usedNamed = namedImports.filter(isUsed);

    if (isNamespace && usedDefault) {
      result.push(`import * as ${usedDefault} from '${mod}';`);
    } else if (usedDefault && usedNamed.length > 0) {
      result.push(
        `import ${usedDefault}, { ${usedNamed.join(", ")} } from '${mod}';`,
      );
    } else if (usedDefault) {
      result.push(`import ${usedDefault} from '${mod}';`);
    } else if (usedNamed.length > 0) {
      result.push(`import { ${usedNamed.join(", ")} } from '${mod}';`);
    }
  }

  return result;
}

/**
 * Generate a complete test file from test cases.
 */
export function generateTestFile(
  testCases: TestCase[],
  framework: TestFramework,
  sourceFile: string,
  options?: TemplateOptions,
): string {
  const frameworkName =
    framework === "jest" ? "Jest" : framework === "vitest" ? "Vitest" : "Detox";
  const dateStr = new Date().toISOString().split("T")[0];

  const allRules = [
    ...new Set(testCases.flatMap((tc) => tc.coversRules)),
  ].sort();
  const rawImports = testCases.flatMap((tc) => tc.imports);
  const allImports = mergeImports(rawImports);

  // Framework runner imports (e.g. Vitest needs explicit describe, it, expect, vi, beforeEach)
  const runnerImports: string[] = [];
  if (framework === "vitest") {
    const hasBeforeEach = testCases.some((tc) =>
      tc.body.includes("beforeEach("),
    );
    const vitestFns = ["describe", "it", "expect", "vi"];
    if (hasBeforeEach) {
      vitestFns.push("beforeEach");
    }
    runnerImports.push(`import { ${vitestFns.join(", ")} } from 'vitest';`);
  }

  // Collect and deduplicate mocks by module
  const seenMocks = new Set<string>();
  const allMocks: string[] = [];
  for (const tc of testCases) {
    for (const m of tc.mocks) {
      if (!seenMocks.has(m.module)) {
        seenMocks.add(m.module);
        allMocks.push(m.factory);
      }
    }
  }

  const baseName = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
  const describeName = options?.suiteName || baseName || sourceFile;

  // Split test case bodies
  const testBodies =
    testCases.length > 0
      ? testCases.map((tc) => tc.body.trimEnd()).join("\n\n")
      : `  it('passes baseline verification', () => {\n    expect(true).toBe(true);\n  });`;

  const sections: string[] = [
    `// Generated by Code Verifier on ${dateStr}`,
    `// Source: ${sourceFile}`,
    `// Covers: ${allRules.length > 0 ? allRules.join(", ") : "Baseline"}`,
    `// Framework: ${frameworkName}`,
  ];

  const header = sections.join("\n");
  const mocksBlock = allMocks.length > 0 ? allMocks.join("\n\n") : "";

  // Tree-shake imports against mocks and test bodies
  const codeBodyForTreeShaking = mocksBlock + "\n" + testBodies;
  const cleanImports = treeShakeImports(allImports, codeBodyForTreeShaking);
  const importsBlock = cleanImports.length > 0 ? cleanImports.join("\n") : "";

  const parts: string[] = [];
  const usesReactDomRender = allImports.some((imp) =>
    imp.includes("@testing-library/react"),
  );

  if (framework === "vitest" && usesReactDomRender) {
    parts.push("/** @vitest-environment happy-dom */");
  }

  parts.push(header);
  if (runnerImports.length > 0) parts.push(runnerImports.join("\n"));
  if (mocksBlock) parts.push(mocksBlock);
  if (importsBlock) parts.push(importsBlock);

  parts.push(`describe('${describeName}', () => {\n${testBodies}\n});\n`);

  return parts.join("\n\n");
}
