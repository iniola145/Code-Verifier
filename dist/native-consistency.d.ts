import { DiagnosticSeverity, VerificationResult } from './types/verifier';
interface NativeConsistencyOptions {
    projectRoot: string;
    baselineFingerprints?: ReadonlySet<string>;
    failOn?: DiagnosticSeverity;
    disabledRules?: string[];
    severityOverrides?: Record<string, DiagnosticSeverity>;
}
/**
 * Cross-checks JS imports against the checked-out native app: a package that
 * ships an iOS podspec (Expo SDK packages, community RN libraries) but whose
 * pod is absent from ios/Podfile.lock means the native app was built before
 * the dependency was added. The JS import resolves while the native side
 * throws "Cannot find native module 'X'" at runtime.
 */
export declare function verifyNativeConsistency(targets: string[], options: NativeConsistencyOptions): VerificationResult[];
export {};
