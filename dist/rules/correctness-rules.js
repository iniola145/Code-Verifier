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
exports.CORRECTNESS_RULES = exports.AsyncPromiseExecutorRule = exports.AsyncForEachRule = exports.MissingArrayCallbackReturnRule = exports.AssignmentInConditionRule = void 0;
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
const ast_1 = require("../parser/ast");
function emit(ctx, node, ruleId, severity, message, explanation, remediation) {
    const loc = (0, ast_1.nodeToLocation)(node);
    ctx.report({
        id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
        ruleId,
        category: "CORRECTNESS",
        severity,
        message,
        explanation,
        loc,
        codeSnippet: (0, ast_1.extractCodeSnippet)(ctx.lines, loc),
        remediation: { summary: remediation, llmPromptHint: remediation },
    });
}
function methodName(call) {
    const callee = call.callee;
    return t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property)
        ? callee.property.name
        : null;
}
function functionHasOwnReturn(path) {
    if (!t.isBlockStatement(path.node.body))
        return true;
    let found = false;
    path.get("body").traverse({
        Function(inner) {
            inner.skip();
        },
        ReturnStatement(returnPath) {
            found = true;
            returnPath.stop();
        },
    });
    return found;
}
exports.AssignmentInConditionRule = {
    id: "LOGIC-001",
    name: "Assignment in Conditional",
    description: "Detects assignment expressions used as branch or loop conditions.",
    category: "CORRECTNESS",
    defaultSeverity: "HIGH",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            AssignmentExpression(path) {
                const parent = path.parentPath;
                const isCondition = (parent.isIfStatement() ||
                    parent.isWhileStatement() ||
                    parent.isDoWhileStatement() ||
                    parent.isForStatement() ||
                    parent.isConditionalExpression()) &&
                    parent.node.test === path.node;
                if (!isCondition)
                    return;
                emit(ctx, path.node, "LOGIC-001", "HIGH", "An assignment is used as a conditional expression.", "A single equals sign in a condition is frequently a typo that mutates state and evaluates the assigned value.", "Use a comparison operator, or move the intentional assignment to a separate statement.");
            },
        });
    },
};
exports.MissingArrayCallbackReturnRule = {
    id: "LOGIC-002",
    name: "Missing Array Callback Return",
    description: "Detects value-producing array callbacks with block bodies that never return a value.",
    category: "CORRECTNESS",
    defaultSeverity: "HIGH",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                if (![
                    "map",
                    "filter",
                    "find",
                    "findIndex",
                    "some",
                    "every",
                    "reduce",
                ].includes(methodName(path.node) ?? ""))
                    return;
                const callbackPath = path.get("arguments.0");
                if (!callbackPath.isArrowFunctionExpression() &&
                    !callbackPath.isFunctionExpression())
                    return;
                if (!t.isBlockStatement(callbackPath.node.body) ||
                    functionHasOwnReturn(callbackPath))
                    return;
                emit(ctx, callbackPath.node, "LOGIC-002", "HIGH", `The ${methodName(path.node)} callback has a block body but never returns a value.`, "This callback produces undefined for every element, which usually breaks filtering, searching, reduction, or mapping.", "Return the intended value from every reachable callback path, or use forEach for side effects.");
            },
        });
    },
};
exports.AsyncForEachRule = {
    id: "ASYNC-001",
    name: "Async forEach Callback",
    description: "Detects async callbacks passed to forEach, which does not await returned promises.",
    category: "CORRECTNESS",
    defaultSeverity: "HIGH",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                if (methodName(path.node) !== "forEach")
                    return;
                const callback = path.node.arguments[0];
                if ((!t.isArrowFunctionExpression(callback) &&
                    !t.isFunctionExpression(callback)) ||
                    !callback.async)
                    return;
                emit(ctx, path.node, "ASYNC-001", "HIGH", "forEach receives an async callback that it will not await.", "The outer flow continues immediately and callback rejections may become unhandled.", "Use for...of with await for sequential work, or await Promise.all(items.map(async ...)) for concurrent work.");
            },
        });
    },
};
exports.AsyncPromiseExecutorRule = {
    id: "ASYNC-002",
    name: "Async Promise Executor",
    description: "Detects async functions passed to the Promise constructor.",
    category: "CORRECTNESS",
    defaultSeverity: "HIGH",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            NewExpression(path) {
                if (!t.isIdentifier(path.node.callee, { name: "Promise" }))
                    return;
                const executor = path.node.arguments[0];
                if ((!t.isArrowFunctionExpression(executor) &&
                    !t.isFunctionExpression(executor)) ||
                    !executor.async)
                    return;
                emit(ctx, path.node, "ASYNC-002", "HIGH", "Promise is constructed with an async executor.", "Exceptions after an await reject the executor promise rather than the outer constructed promise, which can leave it pending.", "Remove the Promise constructor and return the async operation directly, or use a synchronous executor.");
            },
        });
    },
};
exports.CORRECTNESS_RULES = [
    exports.AssignmentInConditionRule,
    exports.MissingArrayCallbackReturnRule,
    exports.AsyncForEachRule,
    exports.AsyncPromiseExecutorRule,
];
