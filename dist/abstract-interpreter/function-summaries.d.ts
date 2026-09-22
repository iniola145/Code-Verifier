import * as t from '@babel/types';
import { NullabilityValue } from '../types/verifier';
export type SummaryValue = {
    kind: 'FIXED';
    nullability: NullabilityValue;
    taint: 'CLEAN';
} | {
    kind: 'PARAMETER';
    parameterIndex: number;
    sanitized: boolean;
    fieldPath?: string[];
};
export interface FunctionSummary {
    name: string;
    value?: SummaryValue;
    taintSinks: Array<{
        parameterIndex: number;
        kind: 'ASYNC_STORAGE' | 'WEBVIEW';
    }>;
}
export declare function buildFunctionSummaries(ast: t.File, seed?: Map<string, FunctionSummary>): Map<string, FunctionSummary>;
