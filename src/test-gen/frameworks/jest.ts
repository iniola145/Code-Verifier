import { TestCase, TestFramework } from "../types";
import { generateTestFile } from "../templates";

export const jestFramework: TestFramework = "jest";

/**
 * Generate Jest-specific test code.
 */
export function generateJestTest(
  testCases: TestCase[],
  sourceFile: string,
): string {
  return generateTestFile(testCases, "jest", sourceFile);
}

/**
 * Generate Jest setup file content.
 */
export function generateJestSetup(): string {
  return `// Code Verifier Jest Setup
// Add to jest.config.js: setupFilesAfterEnv: ['code-verifier/jest-setup']

const originalError = console.error;
console.error = (...args: any[]) => {
  // Capture errors for Code Verifier analysis
  if (typeof (globalThis as any).__cv_captureError === 'function') {
    (globalThis as any).__cv_captureError(args);
  }
  originalError.apply(console, args);
};

process.on('unhandledRejection', (reason: any) => {
  if (typeof (globalThis as any).__cv_captureRejection === 'function') {
    (globalThis as any).__cv_captureRejection(reason);
  }
});
`;
}
