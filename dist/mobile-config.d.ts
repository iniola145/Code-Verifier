import { DiagnosticSeverity, VerificationResult } from './types/verifier';
interface MobileConfigOptions {
    projectRoot: string;
    baselineFingerprints?: ReadonlySet<string>;
    failOn?: DiagnosticSeverity;
    disabledRules?: string[];
    severityOverrides?: Record<string, DiagnosticSeverity>;
}
export declare function verifyMobileConfigs(targets: string[], options: MobileConfigOptions): VerificationResult[];
export {};
