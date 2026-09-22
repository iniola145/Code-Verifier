import { VerificationResult } from '../types/verifier';
export declare class LLMFormatter {
    /**
     * Formats the verification result as concise, high-signal Markdown tailored for LLMs.
     */
    static formatForLLMPrompt(result: VerificationResult): string;
    private static formatDiagnostic;
    /**
     * Returns a clean JSON string representing the result.
     */
    static formatJSON(result: VerificationResult, pretty?: boolean): string;
}
