import { TestCase, TestFramework } from "../types";
import { generateTestFile } from "../templates";

export const vitestFramework: TestFramework = "vitest";

/**
 * Generate Vitest-specific test code.
 */
export function generateVitestTest(
  testCases: TestCase[],
  sourceFile: string,
): string {
  return generateTestFile(testCases, "vitest", sourceFile);
}
