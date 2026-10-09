import { TestCase, TestFramework } from "../types";

export const detoxFramework: TestFramework = "detox";

/**
 * Generate Detox-specific test code (stub for now).
 */
export function generateDetoxTest(
  testCases: TestCase[],
  sourceFile: string,
): string {
  return `// Detox test generation not yet implemented
// Source: ${sourceFile}
// Test cases: ${testCases.length}
`;
}
