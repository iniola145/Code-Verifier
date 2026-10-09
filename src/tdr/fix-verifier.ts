import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { CodeVerifier } from "../engine";
import { Diagnostic } from "../types/verifier";
import { detectFramework } from "../test-gen/generator";

/**
 * Result of verifying a fix.
 */
export interface FixVerificationResult {
  fixed: boolean;
  remainingFindings: Diagnostic[];
  resolvedFindings: Diagnostic[];
  newFindings: Diagnostic[];
  testResult?: {
    passed: boolean;
    output: string;
  };
}

export interface VerifyFixOptions {
  runTests?: boolean;
  testCommand?: string;
  testFile?: string;
  cwd?: string;
  codeOverride?: string;
  timeoutMs?: number;
  verifier?: CodeVerifier;
  projectRoot?: string;
}

/**
 * Checks whether an original diagnostic is still present in the new diagnostics.
 */
function isDiagnosticStillPresent(
  original: Diagnostic,
  newDiagnostics: Diagnostic[],
): boolean {
  return newDiagnostics.some((d) => {
    // 1. Exact fingerprint match
    if (original.fingerprint && d.fingerprint) {
      if (original.fingerprint === d.fingerprint) return true;
    }

    // 2. Exact rule ID and close line proximity (+/- 2 lines for code shifts)
    if (d.ruleId === original.ruleId) {
      const lineDiff = Math.abs(d.loc.start.line - original.loc.start.line);
      if (lineDiff <= 2) return true;

      // 3. Same code snippet or symbol if available
      if (
        original.codeSnippet &&
        d.codeSnippet &&
        (d.codeSnippet.trim() === original.codeSnippet.trim() ||
          d.codeSnippet.includes(original.codeSnippet.trim()) ||
          original.codeSnippet.includes(d.codeSnippet.trim()))
      ) {
        return true;
      }
    }

    return false;
  });
}

/**
 * Verify that a fix resolves a set of findings for a source file.
 */
export async function verifyFix(
  sourceFile: string,
  originalFindings: Diagnostic[],
  options?: VerifyFixOptions,
): Promise<FixVerificationResult> {
  const resolvedPath = path.resolve(sourceFile);
  const projectRoot = options?.projectRoot || path.dirname(resolvedPath);
  const verifier = options?.verifier || new CodeVerifier({ projectRoot });

  // 1. Run static analysis on the fixed code
  let diagnostics: Diagnostic[] = [];
  if (options?.codeOverride !== undefined) {
    const result = await verifier.verifyCode(
      options.codeOverride,
      resolvedPath,
    );
    diagnostics = result.diagnostics;
  } else if (fs.existsSync(resolvedPath)) {
    const result = await verifier.verifyFile(resolvedPath);
    diagnostics = result.diagnostics;
  } else {
    throw new Error(`Source file not found: ${resolvedPath}`);
  }

  // 2. Check which original findings are resolved vs remaining
  const resolvedFindings: Diagnostic[] = [];
  const remainingFindings: Diagnostic[] = [];

  for (const original of originalFindings) {
    if (isDiagnosticStillPresent(original, diagnostics)) {
      remainingFindings.push(original);
    } else {
      resolvedFindings.push(original);
    }
  }

  // 3. Check for newly introduced findings
  const newFindings = diagnostics.filter(
    (d) => !originalFindings.some((orig) => isDiagnosticStillPresent(orig, [d])),
  );

  // 4. Optionally run tests
  let testResult: { passed: boolean; output: string } | undefined;
  if (options?.runTests) {
    const testCwd = options.cwd || path.dirname(resolvedPath);
    let cmd = options.testCommand;

    // Auto-scope test execution if specific test file is known
    if (!cmd && options.testFile) {
      const framework = detectFramework(testCwd);
      const testPath = path.isAbsolute(options.testFile)
        ? path.relative(testCwd, options.testFile)
        : options.testFile;
      if (framework === "vitest") {
        cmd = `npx vitest run ${testPath}`;
      } else if (framework === "jest") {
        cmd = `npx jest ${testPath}`;
      }
    }

    if (!cmd) {
      cmd = "npm test";
    }

    const timeout = options.timeoutMs || 30000;

    try {
      const output = execSync(cmd, {
        cwd: testCwd,
        encoding: "utf-8",
        stdio: "pipe",
        timeout,
      });
      testResult = { passed: true, output };
    } catch (err: any) {
      testResult = {
        passed: false,
        output: err.stdout
          ? String(err.stdout)
          : err.stderr
            ? String(err.stderr)
            : err.message || String(err),
      };
    }
  }

  // Fixed if all original findings are resolved AND (if tests ran) tests passed
  const staticResolved = remainingFindings.length === 0;
  const testsPassed = testResult ? testResult.passed : true;
  const fixed = staticResolved && testsPassed;

  return {
    fixed,
    remainingFindings,
    resolvedFindings,
    newFindings,
    testResult,
  };
}
