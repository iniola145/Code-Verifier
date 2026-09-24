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
exports.BACKEND_RULES = exports.UnprotectedAdminRouteRule = exports.MissingReturnAfterResponseRule = exports.ErrorWithSuccessStatusRule = exports.ErrorDetailLeakRule = void 0;
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
const ast_1 = require("../parser/ast");
function chain(node) {
    if (t.isIdentifier(node))
        return node.name;
    if (t.isMemberExpression(node) && t.isIdentifier(node.property))
        return `${chain(node.object)}.${node.property.name}`;
    if (t.isCallExpression(node))
        return chain(node.callee);
    return "";
}
function emit(ctx, node, ruleId, severity, message, explanation, remediation) {
    const loc = (0, ast_1.nodeToLocation)(node);
    ctx.report({
        id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
        ruleId,
        category: ruleId.startsWith("AUTH-") ? "SECURITY" : "CORRECTNESS",
        severity,
        message,
        explanation,
        loc,
        codeSnippet: (0, ast_1.extractCodeSnippet)(ctx.lines, loc),
        remediation: { summary: remediation, llmPromptHint: remediation },
    });
}
exports.ErrorDetailLeakRule = {
    id: "API-001",
    name: "Internal Error Detail in Response",
    description: "Detects error stacks and raw exception messages returned in HTTP responses.",
    category: "SECURITY",
    defaultSeverity: "HIGH",
    cweId: "CWE-209",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                const name = chain(path.node.callee);
                if (!/\.(?:json|send)$/.test(name))
                    return;
                const payload = path.node.arguments[0];
                if (!t.isExpression(payload))
                    return;
                let leaks = false;
                path.get("arguments.0").traverse({
                    MemberExpression(memberPath) {
                        if (t.isIdentifier(memberPath.node.property) &&
                            ["stack", "message"].includes(memberPath.node.property.name) &&
                            t.isIdentifier(memberPath.node.object) &&
                            /err|error|exception/i.test(memberPath.node.object.name))
                            leaks = true;
                    },
                });
                if (!leaks)
                    return;
                emit(ctx, path.node, "API-001", "HIGH", "HTTP response exposes raw internal error details.", "Exception messages and stacks can disclose paths, queries, dependencies, and implementation details.", "Return a stable public error code/message and log sanitized technical details server-side.");
            },
        });
    },
};
exports.ErrorWithSuccessStatusRule = {
    id: "API-002",
    name: "Error Payload with Success Status",
    description: "Detects error responses explicitly returned with an HTTP 2xx status.",
    category: "CORRECTNESS",
    defaultSeverity: "MEDIUM",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                if (!/\.json$/.test(chain(path.node.callee)))
                    return;
                const callee = path.node.callee;
                if (!t.isMemberExpression(callee) ||
                    !t.isCallExpression(callee.object) ||
                    !t.isMemberExpression(callee.object.callee) ||
                    !t.isIdentifier(callee.object.callee.property, { name: "status" }))
                    return;
                const status = callee.object.arguments[0];
                if (!t.isNumericLiteral(status) ||
                    status.value < 200 ||
                    status.value >= 300)
                    return;
                const payload = path.node.arguments[0];
                if (!t.isObjectExpression(payload) ||
                    !payload.properties.some((property) => t.isObjectProperty(property) &&
                        ((t.isIdentifier(property.key) &&
                            ["error", "errors"].includes(property.key.name)) ||
                            (t.isStringLiteral(property.key) &&
                                ["error", "errors"].includes(property.key.value)))))
                    return;
                emit(ctx, path.node, "API-002", "MEDIUM", `Error payload is returned with success status ${status.value}.`, "Clients, caches, monitoring, and retries rely on HTTP status semantics and may treat this failure as success.", "Return the semantically appropriate 4xx or 5xx status code.");
            },
        });
    },
};
exports.MissingReturnAfterResponseRule = {
    id: "API-003",
    name: "Execution Continues After Conditional Response",
    description: "Detects conditional Express responses without return followed by another response.",
    category: "CORRECTNESS",
    defaultSeverity: "HIGH",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            IfStatement(path) {
                if (t.isReturnStatement(path.node.consequent) ||
                    (t.isBlockStatement(path.node.consequent) &&
                        path.node.consequent.body.some(t.isReturnStatement)))
                    return;
                let sends = false;
                path.get("consequent").traverse({
                    CallExpression(callPath) {
                        if (/\.(?:json|send|end|redirect)$/.test(chain(callPath.node.callee)))
                            sends = true;
                    },
                });
                if (!sends)
                    return;
                const parent = path.parentPath;
                if (!parent.isBlockStatement())
                    return;
                const index = parent.node.body.indexOf(path.node);
                const later = parent.node.body.slice(index + 1).some((statement) => {
                    let found = false;
                    (0, traverse_1.default)(t.file(t.program([statement])), {
                        CallExpression(callPath) {
                            if (/\.(?:json|send|end|redirect)$/.test(chain(callPath.node.callee)))
                                found = true;
                        },
                    });
                    return found;
                });
                if (!later)
                    return;
                emit(ctx, path.node, "API-003", "HIGH", "Execution can continue after sending a conditional HTTP response.", "The handler may send a second response or perform state-changing work after an error response.", "Return the response or add an explicit return immediately after sending it.");
            },
        });
    },
};
exports.UnprotectedAdminRouteRule = {
    id: "AUTH-001",
    name: "Unprotected Administrative Route",
    description: "Detects explicit admin route paths with no middleware before the handler.",
    category: "SECURITY",
    defaultSeverity: "HIGH",
    cweId: "CWE-862",
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                const callee = path.node.callee;
                if (!t.isMemberExpression(callee) ||
                    !t.isIdentifier(callee.property) ||
                    !["get", "post", "put", "patch", "delete"].includes(callee.property.name))
                    return;
                const route = path.node.arguments[0];
                if (!t.isStringLiteral(route) ||
                    !/(?:^|\/)admin(?:\/|$)/i.test(route.value))
                    return;
                if (path.node.arguments.length !== 2)
                    return;
                const handler = path.node.arguments[1];
                if (!t.isFunctionExpression(handler) &&
                    !t.isArrowFunctionExpression(handler))
                    return;
                emit(ctx, path.node, "AUTH-001", "HIGH", `Administrative route '${route.value}' has no authorization middleware.`, "Authentication inside a handler is easy to omit or bypass; administrative routes need explicit access control.", "Insert tested authentication and role/permission middleware before the route handler.");
            },
        });
    },
};
exports.BACKEND_RULES = [
    exports.ErrorDetailLeakRule,
    exports.ErrorWithSuccessStatusRule,
    exports.MissingReturnAfterResponseRule,
    exports.UnprotectedAdminRouteRule,
];
