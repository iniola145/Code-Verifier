import { CheckStatus, ProjectVerificationResult } from './types/verifier';
export interface ProjectCheckOptions {
    timeoutMs?: number;
    maxOutputBytes?: number;
    typecheck?: boolean;
    eslint?: boolean;
    build?: boolean;
    tests?: boolean;
    audit?: boolean;
    expoDoctor?: boolean;
}
export declare function verifyProject(projectRoot: string, options?: ProjectCheckOptions): ProjectVerificationResult;
export declare function classifyESLintExit(code: number | null): CheckStatus;
export declare function classifyNpmAuditExit(code: number | null, output: string): CheckStatus;
export declare function summarizeNpmAuditOutput(output: string): string;
export declare function summarizeESLintOutput(output: string): string;
export declare function formatProjectChecks(result: ProjectVerificationResult): string;
