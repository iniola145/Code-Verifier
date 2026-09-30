import { parse, ParserOptions } from "@babel/parser";
import * as t from "@babel/types";
import { RangeLocation } from "../types/verifier";

export interface ParsedFile {
  code: string;
  lines: string[];
  ast: t.File;
}

const DEFAULT_PARSER_OPTIONS: ParserOptions = {
  sourceType: "module",
  plugins: [
    "typescript",
    "jsx",
    "classProperties",
    "dynamicImport",
    "optionalChaining",
    "nullishCoalescingOperator",
    ["decorators", { decoratorsBeforeExport: true }],
  ],
  tokens: true,
  createParenthesizedExpressions: true,
};

/**
 * Parses JavaScript, TypeScript, JSX, or TSX code into a Babel AST.
 */
export function parseSourceCode(
  code: string,
  filename = "input.tsx",
): ParsedFile {
  const lines = code.split(/\r?\n/);
  try {
    const ast = parse(code, {
      ...DEFAULT_PARSER_OPTIONS,
      sourceFilename: filename,
    });
    return { code, lines, ast };
  } catch (error: any) {
    throw new Error(`Failed to parse ${filename}: ${error.message}`);
  }
}

/**
 * Extracts a formatted code snippet with 1 line of context around the target location.
 */
export function extractCodeSnippet(
  lines: string[],
  loc: RangeLocation,
  contextLines = 1,
): string {
  const startLineIdx = Math.max(0, loc.start.line - 1 - contextLines);
  const endLineIdx = Math.min(
    lines.length - 1,
    loc.end.line - 1 + contextLines,
  );

  const snippetLines: string[] = [];
  for (let i = startLineIdx; i <= endLineIdx; i++) {
    const lineNum = i + 1;
    const isTarget = lineNum >= loc.start.line && lineNum <= loc.end.line;
    const prefix = isTarget ? "> " : "  ";
    const paddedNum = lineNum.toString().padStart(4, " ");
    snippetLines.push(`${prefix}${paddedNum} | ${lines[i]}`);
  }

  return snippetLines.join("\n");
}

/**
 * Converts a Babel AST node location to standard RangeLocation.
 */
export function nodeToLocation(node: {
  loc?: t.SourceLocation | null;
}): RangeLocation {
  if (node.loc) {
    return {
      start: { line: node.loc.start.line, column: node.loc.start.column },
      end: { line: node.loc.end.line, column: node.loc.end.column },
    };
  }
  return {
    start: { line: 1, column: 0 },
    end: { line: 1, column: 0 },
  };
}
