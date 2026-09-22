import { Diagnostic } from './types/verifier';
/** Project-wide TypeScript checker used for rules that cannot be soundly inferred from syntax alone. */
export declare class SemanticAnalysisIndex {
    private readonly program;
    private readonly checker;
    static fromFiles(files: string[]): SemanticAnalysisIndex;
    private constructor();
    diagnosticsForFile(filePath: string): Diagnostic[];
    private isPromiseLike;
    private isThenableType;
    private hasRejectionHandler;
    private makeDiagnostic;
}
