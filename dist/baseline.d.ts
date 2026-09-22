import { Diagnostic } from './types/verifier';
export interface BaselineFile {
    version: 1;
    fingerprints: string[];
}
export declare function diagnosticFingerprint(diagnostic: Diagnostic, lines: string[], projectRoot?: string): string;
export declare function loadBaseline(filePath: string): Set<string>;
export declare function writeBaseline(filePath: string, diagnostics: Diagnostic[]): void;
