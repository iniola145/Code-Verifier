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
exports.buildFunctionSummaries = buildFunctionSummaries;
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
function buildFunctionSummaries(ast, seed = new Map()) {
    const summaries = new Map(seed);
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        (0, traverse_1.default)(ast, {
            Function(path) {
                const name = functionName(path);
                if (!name)
                    return;
                const expressions = returnExpressions(path);
                let value;
                if (expressions) {
                    const values = expressions.map((expr) => summarizeExpression(expr, path.node.params, summaries));
                    const first = values[0];
                    if (first && values.every((candidate) => sameSummary(candidate, first)))
                        value = first;
                }
                const taintSinks = summarizeTaintSinks(path, summaries);
                const next = value || taintSinks.length > 0 ? { name, value, taintSinks } : undefined;
                if (next && JSON.stringify(summaries.get(name)) !== JSON.stringify(next)) {
                    summaries.set(name, next);
                    changed = true;
                }
            },
        });
        if (!changed)
            break;
    }
    return summaries;
}
function summarizeTaintSinks(path, summaries) {
    const sinks = [];
    const params = path.node.params;
    const add = (expr, kind) => {
        if (!t.isIdentifier(expr))
            return;
        const parameterIndex = params.findIndex((param) => t.isIdentifier(param, { name: expr.name }));
        if (parameterIndex >= 0 && !sinks.some((sink) => sink.parameterIndex === parameterIndex && sink.kind === kind)) {
            sinks.push({ parameterIndex, kind });
        }
    };
    path.traverse({
        CallExpression(callPath) {
            if (callPath.getFunctionParent()?.node !== path.node)
                return;
            const call = callPath.node;
            if (t.isMemberExpression(call.callee) &&
                t.isIdentifier(call.callee.object, { name: 'AsyncStorage' }) &&
                t.isIdentifier(call.callee.property, { name: 'setItem' })) {
                const argument = call.arguments[1];
                add(t.isExpression(argument) ? argument : null, 'ASYNC_STORAGE');
            }
            const name = summaryCalleeName(call.callee);
            const summary = name ? summaries.get(name) : undefined;
            if (summary) {
                for (const sink of summary.taintSinks) {
                    const argument = call.arguments[sink.parameterIndex];
                    add(t.isExpression(argument) ? argument : null, sink.kind);
                }
            }
        },
        JSXAttribute(attributePath) {
            if (attributePath.getFunctionParent()?.node !== path.node)
                return;
            const attribute = attributePath.node;
            if (!t.isJSXIdentifier(attribute.name) ||
                !['html', 'injectedJavaScript', 'source'].includes(attribute.name.name) ||
                !t.isJSXExpressionContainer(attribute.value))
                return;
            add(t.isExpression(attribute.value.expression) ? attribute.value.expression : null, 'WEBVIEW');
        },
    });
    return sinks;
}
function functionName(path) {
    const node = path.node;
    if (t.isFunctionDeclaration(node) && node.id)
        return node.id.name;
    if (t.isVariableDeclarator(path.parent) && t.isIdentifier(path.parent.id))
        return path.parent.id.name;
    if (t.isExportDefaultDeclaration(path.parent))
        return 'default';
    return null;
}
function returnExpressions(path) {
    if (!t.isBlockStatement(path.node.body)) {
        return [t.isExpression(path.node.body) ? path.node.body : null];
    }
    const returns = [];
    path.traverse({
        ReturnStatement(returnPath) {
            if (returnPath.getFunctionParent()?.node !== path.node)
                return;
            returns.push(t.isExpression(returnPath.node.argument) ? returnPath.node.argument : null);
        },
    });
    // A reachable implicit fall-through is difficult to prove cheaply. Only
    // summarize block functions whose final statement is an explicit return.
    const last = path.node.body.body.at(-1);
    if (!last || !t.isReturnStatement(last))
        return null;
    return returns;
}
function summarizeExpression(expr, params, summaries) {
    if (!expr || (t.isIdentifier(expr) && expr.name === 'undefined')) {
        return { kind: 'FIXED', nullability: 'Undefined', taint: 'CLEAN' };
    }
    if (t.isNullLiteral(expr))
        return { kind: 'FIXED', nullability: 'Null', taint: 'CLEAN' };
    if (t.isStringLiteral(expr) || t.isNumericLiteral(expr) || t.isBooleanLiteral(expr) ||
        t.isObjectExpression(expr) || t.isArrayExpression(expr) || t.isTemplateLiteral(expr) ||
        t.isNewExpression(expr) || t.isJSXElement(expr) || t.isJSXFragment(expr)) {
        return { kind: 'FIXED', nullability: 'NonNull', taint: 'CLEAN' };
    }
    if (t.isIdentifier(expr)) {
        const parameterIndex = params.findIndex((param) => t.isIdentifier(param, { name: expr.name }));
        if (parameterIndex >= 0)
            return { kind: 'PARAMETER', parameterIndex, sanitized: false };
    }
    if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
        const path = [];
        let current = expr;
        while (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) {
            const property = !current.computed && t.isIdentifier(current.property)
                ? current.property.name
                : current.computed && (t.isStringLiteral(current.property) || t.isNumericLiteral(current.property))
                    ? String(current.property.value) : null;
            if (property === null)
                return null;
            path.unshift(property);
            current = current.object;
        }
        if (t.isIdentifier(current)) {
            const parameterIndex = params.findIndex((param) => t.isIdentifier(param, { name: current.name }));
            if (parameterIndex >= 0)
                return { kind: 'PARAMETER', parameterIndex, sanitized: false, fieldPath: path };
        }
    }
    if (t.isCallExpression(expr)) {
        const name = summaryCalleeName(expr.callee);
        const summary = name ? summaries.get(name) : undefined;
        if (summary?.value?.kind === 'FIXED')
            return summary.value;
        if (summary?.value?.kind === 'PARAMETER') {
            const argument = expr.arguments[summary.value.parameterIndex];
            if (t.isIdentifier(argument)) {
                const parameterIndex = params.findIndex((param) => t.isIdentifier(param, { name: argument.name }));
                if (parameterIndex >= 0) {
                    return { kind: 'PARAMETER', parameterIndex, sanitized: summary.value.sanitized,
                        fieldPath: summary.value.fieldPath };
                }
            }
            else if (t.isMemberExpression(argument) || t.isOptionalMemberExpression(argument)) {
                const argumentSummary = summarizeExpression(argument, params, summaries);
                if (argumentSummary?.kind === 'PARAMETER') {
                    return { ...argumentSummary, sanitized: summary.value.sanitized,
                        fieldPath: [...(argumentSummary.fieldPath ?? []), ...(summary.value.fieldPath ?? [])] };
                }
            }
        }
    }
    if (t.isCallExpression(expr) &&
        t.isMemberExpression(expr.callee) &&
        t.isIdentifier(expr.callee.object, { name: 'DOMPurify' }) &&
        t.isIdentifier(expr.callee.property, { name: 'sanitize' }) &&
        t.isIdentifier(expr.arguments[0])) {
        const parameterIndex = params.findIndex((param) => t.isIdentifier(param, { name: expr.arguments[0].name }));
        if (parameterIndex >= 0)
            return { kind: 'PARAMETER', parameterIndex, sanitized: true };
    }
    return null;
}
function summaryCalleeName(callee) {
    if (t.isIdentifier(callee))
        return callee.name;
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && t.isIdentifier(callee.property)) {
        return `${callee.object.name}.${callee.property.name}`;
    }
    return null;
}
function sameSummary(a, b) {
    if (!a || a.kind !== b.kind)
        return false;
    if (a.kind === 'FIXED' && b.kind === 'FIXED') {
        return a.nullability === b.nullability && a.taint === b.taint;
    }
    return a.kind === 'PARAMETER' && b.kind === 'PARAMETER' &&
        a.parameterIndex === b.parameterIndex && a.sanitized === b.sanitized &&
        JSON.stringify(a.fieldPath ?? []) === JSON.stringify(b.fieldPath ?? []);
}
