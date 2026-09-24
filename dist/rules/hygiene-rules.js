"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HYGIENE_RULES = exports.UnusedLocalRule = exports.InsecureHttpUrlRule = exports.DebuggerRule = exports.TargetBlankRule = void 0;
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
const ast_1 = require("../parser/ast");
const react_correctness_rules_1 = require("./react-correctness-rules");
// =========================================================================
// Hygiene rules: low-noise, LOW-severity advisories. They never fail a run.
// =========================================================================
// -------------------------------------------------------------------------
// 1. `target="_blank"` without rel="noopener" (reverse tabnabbing).
// -------------------------------------------------------------------------
exports.TargetBlankRule = {
    id: "WEB-001",
    name: 'target="_blank" without rel="noopener"',
    description: "Links opening a new tab can access window.opener and redirect the origin page (reverse tabnabbing). Modern browsers imply noopener, so this is advisory; older in-app WebViews are not.",
    category: "SECURITY",
    defaultSeverity: "LOW",
    cweId: "CWE-1022",
    check: (ctx) => {
        (0, traverse_1.default)(ctx.ast, {
            JSXElement(path) {
                const opening = path.node.openingElement;
                const attrs = opening.attributes.filter(t.isJSXAttribute);
                const target = attrs.find((a) => t.isJSXIdentifier(a.name, { name: "target" }));
                const targetValue = target && t.isStringLiteral(target.value)
                    ? target.value.value
                    : target &&
                        t.isJSXExpressionContainer(target.value) &&
                        t.isStringLiteral(target.value.expression)
                        ? target.value.expression.value
                        : null;
                if (targetValue !== "_blank")
                    return;
                const rel = attrs.find((a) => t.isJSXIdentifier(a.name, { name: "rel" }));
                const relValue = rel && t.isStringLiteral(rel.value)
                    ? rel.value.value
                    : rel &&
                        t.isJSXExpressionContainer(rel.value) &&
                        t.isStringLiteral(rel.value.expression)
                        ? rel.value.expression.value
                        : "";
                if (relValue.split(/\s+/).includes("noopener"))
                    return;
                const loc = (0, ast_1.nodeToLocation)(path.node);
                ctx.report({
                    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:WEB-001`,
                    ruleId: "WEB-001",
                    cweId: "CWE-1022",
                    category: "SECURITY",
                    severity: "LOW",
                    message: 'target="_blank" without rel="noopener" (reverse tabnabbing risk).',
                    explanation: "The opened page can set window.opener.location to phish the user on the original tab. Modern browsers imply noopener; older in-app WebViews may not.",
                    loc,
                    codeSnippet: (0, ast_1.extractCodeSnippet)(ctx.lines, loc),
                    remediation: {
                        summary: 'Add rel="noopener noreferrer" to the link.',
                        suggestedFix: 'rel="noopener noreferrer"',
                        llmPromptHint: 'Add rel="noopener noreferrer" alongside target="_blank".',
                    },
                });
            },
        });
    },
};
// -------------------------------------------------------------------------
// 2. `debugger` statement left in code (CWE-489).
// -------------------------------------------------------------------------
exports.DebuggerRule = {
    id: "HYG-001",
    name: "Debugger Statement",
    description: "A `debugger` statement left in shipped code pauses execution in any attached devtools.",
    category: "CORRECTNESS",
    defaultSeverity: "LOW",
    cweId: "CWE-489",
    check: (ctx) => {
        (0, traverse_1.default)(ctx.ast, {
            DebuggerStatement(path) {
                const loc = (0, ast_1.nodeToLocation)(path.node);
                ctx.report({
                    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:HYG-001`,
                    ruleId: "HYG-001",
                    cweId: "CWE-489",
                    category: "CORRECTNESS",
                    severity: "LOW",
                    message: "debugger statement left in code.",
                    explanation: "In production builds this pauses execution when devtools are attached; in dev it is almost always a leftover debugging aid.",
                    loc,
                    codeSnippet: (0, ast_1.extractCodeSnippet)(ctx.lines, loc),
                    remediation: {
                        summary: "Remove the debugger statement.",
                        llmPromptHint: "Delete the debugger statement before shipping.",
                    },
                });
            },
        });
    },
};
// -------------------------------------------------------------------------
// 3. Insecure http:// URLs (CWE-319) — advisory; only URL-bearing contexts.
// -------------------------------------------------------------------------
const HTTP_HOST_EXEMPT = [
    /^localhost(?::|$)/,
    /^127\./,
    /^0\.0\.0\.0/,
    /^10\./,
    /^192\.168\./,
    /^[^.]+$/, // bare single-label host (dev gateways)
    /example\.(com|org)$/,
];
const URL_BEARING_ATTRS = new Set([
    "src",
    "href",
    "uri",
    "url",
    "endpoint",
    "baseURL",
    "baseUrl",
    "server",
    "apiUrl",
    "api_url",
    "source",
    "link",
]);
const URLISH_VAR = /url|uri|host|endpoint|base|server|api/i;
exports.InsecureHttpUrlRule = {
    id: "NET-001",
    name: "Insecure HTTP URL",
    description: "Cleartext http:// URLs can be read or modified in transit; iOS ATS blocks them by default and Android blocks cleartext since API 28. Only URL-bearing contexts are flagged to keep noise down.",
    category: "SECURITY",
    defaultSeverity: "LOW",
    cweId: "CWE-319",
    check: (ctx) => {
        (0, traverse_1.default)(ctx.ast, {
            StringLiteral(path) {
                const value = path.node.value;
                if (!value.startsWith("http://"))
                    return;
                if (/w3\.org|dublincore|schema/i.test(value))
                    return;
                const host = value.slice(7).split(/[/?#]/)[0];
                if (HTTP_HOST_EXEMPT.some((re) => re.test(host)))
                    return;
                const parent = path.parent;
                const inUrlContext = (t.isJSXAttribute(parent) &&
                    t.isJSXIdentifier(parent.name) &&
                    URL_BEARING_ATTRS.has(parent.name.name)) ||
                    (t.isVariableDeclarator(parent) &&
                        t.isIdentifier(parent.id) &&
                        URLISH_VAR.test(parent.id.name)) ||
                    (t.isObjectProperty(parent) &&
                        t.isIdentifier(parent.key) &&
                        URLISH_VAR.test(parent.key.name)) ||
                    (t.isAssignmentExpression(parent) &&
                        t.isIdentifier(parent.left) &&
                        URLISH_VAR.test(parent.left.name)) ||
                    (t.isCallExpression(parent) && parent.arguments.includes(path.node));
                if (!inUrlContext)
                    return;
                const loc = (0, ast_1.nodeToLocation)(path.node);
                ctx.report({
                    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:NET-001`,
                    ruleId: "NET-001",
                    cweId: "CWE-319",
                    category: "SECURITY",
                    severity: "LOW",
                    message: `Insecure http:// URL '${value}'.`,
                    explanation: "Cleartext HTTP can be read or modified in transit. iOS ATS blocks http by default; Android blocks cleartext by default since API 28 — an http URL signals either a bypass or a bug.",
                    loc,
                    codeSnippet: (0, ast_1.extractCodeSnippet)(ctx.lines, loc),
                    remediation: {
                        summary: "Use https:// for this URL.",
                        suggestedFix: value.replace("http://", "https://"),
                        llmPromptHint: `Replace '${value}' with '${value.replace("http://", "https://")}'.`,
                    },
                });
            },
        });
    },
};
// -------------------------------------------------------------------------
// 4. Unused local declarations (dead code / forgotten wiring).
// -------------------------------------------------------------------------
exports.UnusedLocalRule = {
    id: "HYG-002",
    name: "Unused Local Declaration",
    description: "Detects const/let declarations and function declarations that are never referenced afterwards, or that are assigned but never read. Exports, destructuring patterns, and _-prefixed names are exempt.",
    category: "CORRECTNESS",
    defaultSeverity: "LOW",
    check: (ctx) => {
        const jsxNames = (0, react_correctness_rules_1.collectJsxIdentifierNames)(ctx);
        const exportNames = new Set();
        (0, traverse_1.default)(ctx.ast, {
            ExportSpecifier(path) {
                exportNames.add(path.node.local.name);
            },
        });
        const report = (node, message, explanation, remediation) => {
            const loc = (0, ast_1.nodeToLocation)(node);
            ctx.report({
                id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:HYG-002`,
                ruleId: "HYG-002",
                category: "CORRECTNESS",
                severity: "LOW",
                message,
                explanation,
                loc,
                codeSnippet: (0, ast_1.extractCodeSnippet)(ctx.lines, loc),
                remediation: { summary: remediation, llmPromptHint: remediation },
            });
        };
        // Only a declaration that is the export statement's DIRECT child is
        // exported; anything merely nested inside an exported component still
        // has all of its references in-file.
        const isDirectlyExported = (path) => {
            const parent = path.parentPath;
            return (!!parent &&
                (parent.isExportNamedDeclaration() ||
                    parent.isExportDefaultDeclaration()));
        };
        (0, traverse_1.default)(ctx.ast, {
            VariableDeclarator(path) {
                const { id, init } = path.node;
                if (!t.isIdentifier(id) || id.name.startsWith("_"))
                    return;
                // useState pairs are REACT-008's domain; destructuring patterns are exempt.
                if (t.isCallExpression(init) &&
                    (t.isIdentifier(init.callee, { name: "useState" }) ||
                        (t.isMemberExpression(init.callee) &&
                            t.isIdentifier(init.callee.property, { name: "useState" }))))
                    return;
                if (path.parentPath.node.declare)
                    return;
                if (isDirectlyExported(path.parentPath) ||
                    exportNames.has(id.name) ||
                    jsxNames.has(id.name))
                    return;
                const binding = path.scope.getBinding(id.name);
                if (!binding || binding.references !== 0)
                    return;
                if (binding.constantViolations.length > 0) {
                    report(path.node, `Local variable '${id.name}' is assigned but its value is never read.`, "Every assignment to it is wasted work, and the value it holds is a silent dead end — often a computed result that was meant to be returned, rendered, or checked but never was.", "Remove the variable, or return/render/check it where the computed value was intended to be used.");
                }
                else {
                    report(path.node, `Local declaration '${id.name}' is never used.`, "It is initialized and never referenced afterwards — a leftover, or a sign that a value was computed but never wired into the logic that needed it.", "Remove the declaration, or use it where the value was intended to matter.");
                }
            },
            FunctionDeclaration(path) {
                const { id, body } = path.node;
                if (!id || id.name.startsWith("_") || !body)
                    return;
                if (path.node.declare)
                    return;
                // Non-exported top-level components are commonly invoked by the
                // framework (routes, screens, entry points) rather than in-file.
                if (t.isProgram(path.parent) && /^[A-Z]/.test(id.name))
                    return;
                if (isDirectlyExported(path) ||
                    exportNames.has(id.name) ||
                    jsxNames.has(id.name))
                    return;
                const binding = path.scope.getBinding(id.name);
                if (!binding || binding.references !== 0)
                    return;
                report(path.node, `Function '${id.name}' is declared but never called.`, "Nothing references it — dead code that still has to be read, maintained, and bundled. If it is meant to be this file's public API, export it; otherwise it is a leftover.", "Remove the function, export it if it is part of the file's API, or call it where it was intended to run.");
            },
        });
    },
};
exports.HYGIENE_RULES = [
    exports.TargetBlankRule,
    exports.DebuggerRule,
    exports.InsecureHttpUrlRule,
    exports.UnusedLocalRule,
];
