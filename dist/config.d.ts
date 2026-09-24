import { DiagnosticSeverity } from "./types/verifier";
export interface VerifierConfig {
    exclude: string[];
    disable: string[];
    severities: Record<string, DiagnosticSeverity>;
    baseline?: string;
    failOn: DiagnosticSeverity;
}
/**
 * Finds the nearest .codeverifier.json, walking up from `startDir` to the
 * filesystem root. Returns the default config when none exists.
 */
export declare function loadConfig(startDir: string): {
    config: VerifierConfig;
    configPath: string | null;
    errors: string[];
};
/**
 * Simple glob -> RegExp: a globstar crosses directories, `*` stays within
 * one segment, `?` is one char. A leading globstar-slash also matches at
 * the root.
 */
export declare function globToRegExp(pattern: string): RegExp;
/** True when a path matches any exclude glob (also tried on the basename). */
export declare function isExcluded(filePath: string, patterns: string[]): boolean;
