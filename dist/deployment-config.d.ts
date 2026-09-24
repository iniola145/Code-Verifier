import { DiagnosticSeverity, VerificationResult } from "./types/verifier";
interface Options {
    projectRoot: string;
    baselineFingerprints?: ReadonlySet<string>;
    failOn?: DiagnosticSeverity;
    disabledRules?: string[];
    severityOverrides?: Record<string, DiagnosticSeverity>;
}
export declare function verifyDeploymentConfigs(targets: string[], options: Options): VerificationResult[];
export {};
