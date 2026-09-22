"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSourceCode = parseSourceCode;
exports.extractCodeSnippet = extractCodeSnippet;
exports.nodeToLocation = nodeToLocation;
const parser_1 = require("@babel/parser");
const DEFAULT_PARSER_OPTIONS = {
    sourceType: 'module',
    plugins: [
        'typescript',
        'jsx',
        'classProperties',
        'dynamicImport',
        'optionalChaining',
        'nullishCoalescingOperator',
        ['decorators', { decoratorsBeforeExport: true }]
    ],
    tokens: true,
    createParenthesizedExpressions: true,
};
/**
 * Parses JavaScript, TypeScript, JSX, or TSX code into a Babel AST.
 */
function parseSourceCode(code, filename = 'input.tsx') {
    const lines = code.split(/\r?\n/);
    try {
        const ast = (0, parser_1.parse)(code, {
            ...DEFAULT_PARSER_OPTIONS,
            sourceFilename: filename,
        });
        return { code, lines, ast };
    }
    catch (error) {
        throw new Error(`Failed to parse ${filename}: ${error.message}`);
    }
}
/**
 * Extracts a formatted code snippet with 1 line of context around the target location.
 */
function extractCodeSnippet(lines, loc, contextLines = 1) {
    const startLineIdx = Math.max(0, loc.start.line - 1 - contextLines);
    const endLineIdx = Math.min(lines.length - 1, loc.end.line - 1 + contextLines);
    const snippetLines = [];
    for (let i = startLineIdx; i <= endLineIdx; i++) {
        const lineNum = i + 1;
        const isTarget = lineNum >= loc.start.line && lineNum <= loc.end.line;
        const prefix = isTarget ? '> ' : '  ';
        const paddedNum = lineNum.toString().padStart(4, ' ');
        snippetLines.push(`${prefix}${paddedNum} | ${lines[i]}`);
    }
    return snippetLines.join('\n');
}
/**
 * Converts a Babel AST node location to standard RangeLocation.
 */
function nodeToLocation(node) {
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
