import { VerificationResult, ProjectVerificationResult } from '../types/verifier';
/**
 * Emits SARIF 2.1.0 so results integrate with GitHub code scanning,
 * VS Code SARIF viewers, and CI gatekeepers.
 */
export declare function formatSARIF(results: VerificationResult[], projects?: ProjectVerificationResult[]): string;
