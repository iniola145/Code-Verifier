import * as t from '@babel/types';
import { ProjectSummaryIndex } from './abstract-interpreter/project-summaries';
import { SemanticAnalysisIndex } from './semantic-analysis';
import { SymbolTable } from './abstract-interpreter/symbols';
import { Diagnostic, VerificationResult, VerificationRule, NullabilityValue } from './types/verifier';
export interface VerifierOptions {
    rules?: VerificationRule[];
    enableAbstractInterpretation?: boolean;
    disabledRules?: string[];
    severityOverrides?: Record<string, string>;
    projectSummaryIndex?: ProjectSummaryIndex;
    baselineFingerprints?: ReadonlySet<string>;
    failOn?: Diagnostic['severity'];
    projectRoot?: string;
    semanticAnalysisIndex?: SemanticAnalysisIndex;
}
interface FunctionRoot {
    name: string;
    body: t.Statement[];
    paramSeeds: {
        name: string;
        key: string;
        nullability: NullabilityValue;
    }[];
}
/** Collects the module top level plus every function body as CFG roots. */
export declare function collectFunctionRoots(ast: t.File, symbols?: SymbolTable): FunctionRoot[];
export declare class CodeVerifier {
    private rules;
    private enableAI;
    private disabledRules;
    private severityOverrides;
    private projectSummaryIndex?;
    private baselineFingerprints;
    private failOn;
    private projectRoot?;
    private semanticAnalysisIndex?;
    constructor(options?: VerifierOptions);
    /**
     * Verifies source code provided as a string.
     */
    verifyCode(code: string, filePath?: string): Promise<VerificationResult>;
    /**
     * Verifies a source file from filesystem.
     */
    verifyFile(filePath: string): Promise<VerificationResult>;
}
export {};
