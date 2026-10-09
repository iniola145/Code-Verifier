import { Diagnostic } from "../types/verifier";
import { GeneratedTest } from "../test-gen/types";
import type { CodeVerifier } from "../engine";

export type TDRStatus =
  | "pending"
  | "tests_generated"
  | "tests_failing"
  | "fixed"
  | "verified";

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

/**
 * Options for verifying a fix.
 */
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
 * A TDR (Test-Driven Remediation) session.
 */
export interface TDRSession {
  id: string;
  createdAt: string;
  sourceFile: string;
  originalFindings: Diagnostic[];
  generatedTests: GeneratedTest[];
  status: TDRStatus;
  fixCommit?: string;
  verificationResult?: FixVerificationResult;
  existingTestFound?: string;
}
