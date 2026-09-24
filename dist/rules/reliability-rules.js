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
exports.RELIABILITY_RULES = exports.IgnoredMapResultRule = exports.UnreachableStatementRule = exports.FinallyControlFlowRule = exports.EmptyCatchRule = void 0;
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
const ast_1 = require("../parser/ast");
function emit(ctx, node, ruleId, category, severity, message, explanation, remediation) {
    const loc = (0, ast_1.nodeToLocation)(node);
    ctx.report({
        id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
        ruleId,
        category,
        severity,
        message,
        explanation,
        loc,
        codeSnippet: (0, ast_1.extractCodeSnippet)(ctx.lines, loc),
        remediation: { summary: remediation, llmPromptHint: remediation },
    });
}
exports.EmptyCatchRule = {
    id: "REL-001",
    name: "Empty Catch Block",
    description: "Detects exceptions silently discarded by empty catch blocks.",
    category: "CORRECTNESS",
    defaultSeverity: "MEDIUM",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CatchClause(path) {
                if (path.node.body.body.length > 0)
                    return;
                const start = path.node.body.loc?.start.line ?? 1;
                const end = path.node.body.loc?.end.line ?? start;
                const bodyText = ctx.lines.slice(start - 1, end).join("\n");
                if (/\b(?:ignore(?:d)?|intentional(?:ly)?|best[- ]effort|graceful fallback|optional)\b/i.test(bodyText))
                    return;
                emit(ctx, path.node, "REL-001", "CORRECTNESS", "MEDIUM", "An exception is silently discarded by an empty catch block.", "The operation can fail without telemetry, recovery, or propagation, leaving callers to continue with invalid assumptions.", "Handle the expected failure explicitly, add useful context and rethrow, or document a narrowly intentional ignore.");
            },
        });
    },
};
exports.FinallyControlFlowRule = {
    id: "REL-002",
    name: "Control Flow in Finally",
    description: "Detects return, throw, break, or continue statements that override completion from try/catch.",
    category: "CORRECTNESS",
    defaultSeverity: "HIGH",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            TryStatement(path) {
                const finalizer = path.get("finalizer");
                if (!finalizer.node)
                    return;
                finalizer.traverse({
                    Function(inner) {
                        inner.skip();
                    },
                    "ReturnStatement|ThrowStatement|BreakStatement|ContinueStatement"(flowPath) {
                        emit(ctx, flowPath.node, "REL-002", "CORRECTNESS", "HIGH", "Control flow in finally overrides the pending result or error.", "A completion from finally replaces a return value or exception produced by the try or catch block.", "Keep finally limited to cleanup; return or throw after the try statement instead.");
                    },
                });
            },
        });
    },
};
exports.UnreachableStatementRule = {
    id: "LOGIC-003",
    name: "Unreachable Statement",
    description: "Detects statements following unconditional control-flow termination in the same block.",
    category: "CORRECTNESS",
    defaultSeverity: "MEDIUM",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            BlockStatement(path) {
                let terminated = false;
                for (const statement of path.node.body) {
                    if (terminated && !t.isFunctionDeclaration(statement)) {
                        emit(ctx, statement, "LOGIC-003", "CORRECTNESS", "MEDIUM", "This statement is unreachable.", "A preceding return, throw, break, or continue always transfers control away from this block.", "Remove the dead statement or correct the preceding control flow.");
                        break;
                    }
                    terminated =
                        t.isReturnStatement(statement) ||
                            t.isThrowStatement(statement) ||
                            t.isBreakStatement(statement) ||
                            t.isContinueStatement(statement);
                }
            },
        });
    },
};
exports.IgnoredMapResultRule = {
    id: "QUAL-001",
    name: "Ignored map Result",
    description: "Detects map calls used solely as expression statements.",
    category: "PERFORMANCE",
    defaultSeverity: "LOW",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            ExpressionStatement(path) {
                const expression = path.node.expression;
                if (!t.isCallExpression(expression) ||
                    !t.isMemberExpression(expression.callee) ||
                    !t.isIdentifier(expression.callee.property, { name: "map" }))
                    return;
                emit(ctx, expression, "QUAL-001", "PERFORMANCE", "LOW", "The array returned by map() is ignored.", "map allocates a new array for transformed values; ignoring it usually means forEach was intended or a result was accidentally dropped.", "Use forEach for side effects, or assign/return the transformed array.");
            },
        });
    },
};
exports.RELIABILITY_RULES = [
    exports.EmptyCatchRule,
    exports.FinallyControlFlowRule,
    exports.UnreachableStatementRule,
    exports.IgnoredMapResultRule,
];
