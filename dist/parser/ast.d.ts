import * as t from '@babel/types';
import { RangeLocation } from '../types/verifier';
export interface ParsedFile {
    code: string;
    lines: string[];
    ast: t.File;
}
/**
 * Parses JavaScript, TypeScript, JSX, or TSX code into a Babel AST.
 */
export declare function parseSourceCode(code: string, filename?: string): ParsedFile;
/**
 * Extracts a formatted code snippet with 1 line of context around the target location.
 */
export declare function extractCodeSnippet(lines: string[], loc: RangeLocation, contextLines?: number): string;
/**
 * Converts a Babel AST node location to standard RangeLocation.
 */
export declare function nodeToLocation(node: {
    loc?: t.SourceLocation | null;
}): RangeLocation;
