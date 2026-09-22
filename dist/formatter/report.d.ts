import { VerificationResult } from '../types/verifier';
/**
 * Whole-project health report (CLI --format=report): findings aggregated
 * by rule and by file, so a large-repo run shows shape at a glance.
 */
export declare function formatReport(results: VerificationResult[]): string;
