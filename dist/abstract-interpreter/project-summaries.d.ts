import * as t from '@babel/types';
import { FunctionSummary } from './function-summaries';
/**
 * A bounded project index for explicit relative ESM imports. Resolution is
 * restricted to the analyzed file set, so analysis never follows dependencies
 * or reads an unbounded tree behind the caller's back.
 */
export declare class ProjectSummaryIndex {
    private readonly modules;
    private readonly files;
    private readonly tsConfigs;
    static fromFiles(filePaths: string[]): ProjectSummaryIndex;
    summariesForFile(ast: t.File, filePath: string): Map<string, FunctionSummary>;
    private indexFile;
    private linkReExports;
    private composeProjectSummaries;
    private resolveImport;
    private resolveCandidate;
    private loadTsConfigs;
}
