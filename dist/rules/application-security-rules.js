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
exports.APPLICATION_SECURITY_RULES = exports.PermissiveCorsRule = exports.InsecureSessionCookieRule = exports.MassAssignmentRule = exports.UnverifiedJwtRule = exports.SensitiveLoggingRule = void 0;
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
const ast_1 = require("../parser/ast");
function report(ctx, node, ruleId, cweId, severity, message, explanation, remediation) {
    const loc = (0, ast_1.nodeToLocation)(node);
    ctx.report({
        id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
        ruleId,
        cweId,
        category: 'SECURITY',
        severity,
        message,
        explanation,
        loc,
        codeSnippet: (0, ast_1.extractCodeSnippet)(ctx.lines, loc),
        remediation: { summary: remediation, llmPromptHint: remediation },
    });
}
function propertyName(node) {
    if (t.isIdentifier(node))
        return node.name;
    if (t.isStringLiteral(node))
        return node.value;
    return null;
}
function memberParts(node) {
    const parts = [];
    let current = node;
    while (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) {
        const name = !current.computed && t.isIdentifier(current.property)
            ? current.property.name
            : current.computed && t.isStringLiteral(current.property)
                ? current.property.value
                : null;
        if (!name)
            return [];
        parts.unshift(name);
        current = current.object;
    }
    if (t.isIdentifier(current))
        parts.unshift(current.name);
    return parts;
}
function calleeName(node) {
    if (t.isIdentifier(node))
        return node.name;
    return memberParts(node).join('.');
}
const SENSITIVE_NAME = /^(?:password|passwd|passphrase|token|accessToken|refreshToken|idToken|authToken|sessionId|sessionToken|secret|clientSecret|apiKey|authorization|cookie|setCookie|creditCard|cardNumber|cvv|ssn)$/i;
function containsSensitiveValue(node, depth = 0) {
    if (!node || depth > 6)
        return false;
    if (t.isIdentifier(node))
        return SENSITIVE_NAME.test(node.name);
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        return memberParts(node).some((part) => SENSITIVE_NAME.test(part));
    }
    if (t.isObjectExpression(node)) {
        return node.properties.some((property) => {
            if (t.isSpreadElement(property))
                return containsSensitiveValue(property.argument, depth + 1);
            if (!t.isObjectProperty(property))
                return false;
            const name = propertyName(property.key);
            return (name !== null && SENSITIVE_NAME.test(name)) ||
                (t.isExpression(property.value) && containsSensitiveValue(property.value, depth + 1));
        });
    }
    if (t.isArrayExpression(node)) {
        return node.elements.some((element) => element !== null && containsSensitiveValue(element, depth + 1));
    }
    if (t.isTemplateLiteral(node)) {
        return node.expressions.some((expression) => containsSensitiveValue(expression, depth + 1));
    }
    if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
        return containsSensitiveValue(node.left, depth + 1) || containsSensitiveValue(node.right, depth + 1);
    }
    if (t.isConditionalExpression(node)) {
        return containsSensitiveValue(node.consequent, depth + 1) ||
            containsSensitiveValue(node.alternate, depth + 1);
    }
    return false;
}
function resolvesToRequestObject(node, path, depth = 0) {
    if (!node || depth > 6)
        return false;
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        const parts = memberParts(node);
        return ['req', 'request'].includes(parts[0]) && ['body', 'query', 'params'].includes(parts[1]);
    }
    if (t.isIdentifier(node)) {
        const binding = path.scope.getBinding(node.name);
        if (!binding?.constant)
            return false;
        const declarator = binding.path.isVariableDeclarator()
            ? binding.path
            : binding.path.parentPath?.isVariableDeclarator()
                ? binding.path.parentPath
                : null;
        return !!declarator && resolvesToRequestObject(declarator.node.init, binding.path, depth + 1);
    }
    if (t.isObjectExpression(node)) {
        return node.properties.some((property) => t.isSpreadElement(property) && resolvesToRequestObject(property.argument, path, depth + 1));
    }
    if (t.isTSAsExpression(node) || t.isTSTypeAssertion(node) || t.isTSNonNullExpression(node) ||
        t.isParenthesizedExpression(node)) {
        return resolvesToRequestObject(node.expression, path, depth + 1);
    }
    return false;
}
function objectValue(object, key) {
    for (const property of object.properties) {
        if (!t.isObjectProperty(property) || property.computed || propertyName(property.key) !== key)
            continue;
        return t.isExpression(property.value) ? property.value : null;
    }
    return null;
}
exports.SensitiveLoggingRule = {
    id: 'SEC-013',
    name: 'Sensitive Data in Logs',
    description: 'Detects direct logging of credentials, tokens, session identifiers, and payment secrets.',
    category: 'SECURITY',
    defaultSeverity: 'HIGH',
    cweId: 'CWE-532',
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                const name = calleeName(path.node.callee);
                if (!/^(?:console|logger|log)\.(?:log|info|debug|warn|error|trace)$/.test(name))
                    return;
                if (!path.node.arguments.some((argument) => t.isExpression(argument) && containsSensitiveValue(argument)))
                    return;
                report(ctx, path.node, 'SEC-013', 'CWE-532', 'HIGH', 'A sensitive value is written directly to application logs.', 'Logs are commonly retained and broadly accessible; credentials and session material in them can enable account compromise.', 'Remove the value or replace it with an explicitly redacted or one-way hashed correlation value.');
            },
        });
    },
};
exports.UnverifiedJwtRule = {
    id: 'SEC-014',
    name: 'JWT Decoded Without Verification',
    description: 'Detects jsonwebtoken decode calls on request or authentication token values.',
    category: 'SECURITY',
    defaultSeverity: 'HIGH',
    cweId: 'CWE-347',
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                const name = calleeName(path.node.callee);
                if (name !== 'jwt.decode' && name !== 'jsonwebtoken.decode')
                    return;
                const argument = path.node.arguments[0];
                if (!t.isExpression(argument))
                    return;
                const functionParent = path.getFunctionParent();
                const functionName = functionParent && t.isFunctionDeclaration(functionParent.node)
                    ? functionParent.node.id?.name ?? ''
                    : '';
                if (!containsSensitiveValue(argument) && !/auth|login|session|verify|middleware/i.test(functionName))
                    return;
                report(ctx, path.node, 'SEC-014', 'CWE-347', 'HIGH', 'JWT claims are decoded without verifying the token signature.', 'Decoding only parses attacker-controlled claims; it does not establish signature validity, issuer, audience, or expiration.', 'Use jwt.verify with a trusted key and an explicit algorithm, issuer, and audience allowlist before trusting claims.');
            },
        });
    },
};
const PERSISTENCE_METHODS = new Set(['create', 'insert', 'insertOne', 'update', 'updateOne', 'updateMany',
    'findOneAndUpdate', 'findByIdAndUpdate', 'upsert', 'save']);
exports.MassAssignmentRule = {
    id: 'SEC-015',
    name: 'Request Object Mass Assignment',
    description: 'Detects whole request objects passed into persistence and object-assignment APIs.',
    category: 'SECURITY',
    defaultSeverity: 'HIGH',
    cweId: 'CWE-915',
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                const name = calleeName(path.node.callee);
                let candidate = null;
                if (name === 'Object.assign') {
                    const source = path.node.arguments[1];
                    candidate = t.isExpression(source) ? source : null;
                }
                else {
                    const method = name.split('.').at(-1) ?? '';
                    if (!PERSISTENCE_METHODS.has(method))
                        return;
                    const argumentIndex = ['update', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate']
                        .includes(method) && path.node.arguments.length > 1 ? 1 : 0;
                    const argument = path.node.arguments[argumentIndex];
                    candidate = t.isExpression(argument) ? argument : null;
                }
                if (!candidate || !resolvesToRequestObject(candidate, path))
                    return;
                report(ctx, path.node, 'SEC-015', 'CWE-915', 'HIGH', 'A whole request object is passed directly into an object or persistence update.', 'Attackers can submit unexpected fields such as roles, ownership, approval state, prices, or internal flags.', 'Construct a DTO from an allowlist of permitted fields, validate it, and pass only that object to persistence.');
            },
        });
    },
};
const SESSION_COOKIE = /session|sid|auth|token|jwt|refresh/i;
exports.InsecureSessionCookieRule = {
    id: 'SEC-016',
    name: 'Insecure Session Cookie',
    description: 'Detects security-sensitive Express cookies without Secure, HttpOnly, and SameSite protection.',
    category: 'SECURITY',
    defaultSeverity: 'HIGH',
    cweId: 'CWE-614',
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                const name = calleeName(path.node.callee);
                if (!name.endsWith('.cookie'))
                    return;
                const cookieName = path.node.arguments[0];
                if (!t.isStringLiteral(cookieName) || !SESSION_COOKIE.test(cookieName.value))
                    return;
                const options = path.node.arguments[2];
                const secure = t.isObjectExpression(options) ? objectValue(options, 'secure') : null;
                const httpOnly = t.isObjectExpression(options) ? objectValue(options, 'httpOnly') : null;
                const sameSite = t.isObjectExpression(options) ? objectValue(options, 'sameSite') : null;
                const protectedCookie = t.isBooleanLiteral(secure, { value: true }) &&
                    t.isBooleanLiteral(httpOnly, { value: true }) &&
                    ((t.isStringLiteral(sameSite) && /^(strict|lax)$/i.test(sameSite.value)) ||
                        t.isBooleanLiteral(sameSite, { value: true }));
                if (protectedCookie)
                    return;
                report(ctx, path.node, 'SEC-016', 'CWE-614', 'HIGH', `Security-sensitive cookie '${cookieName.value}' lacks explicit Secure, HttpOnly, or restrictive SameSite protection.`, 'Missing cookie attributes can expose session material over cleartext transport, client-side script access, or cross-site requests.', 'Set secure: true, httpOnly: true, and sameSite: "strict" or "lax" for the session cookie.');
            },
        });
    },
};
exports.PermissiveCorsRule = {
    id: 'SEC-017',
    name: 'Credentialed Permissive CORS',
    description: 'Detects CORS configuration that combines credentials with wildcard or reflected origins.',
    category: 'SECURITY',
    defaultSeverity: 'HIGH',
    cweId: 'CWE-942',
    check(ctx) {
        (0, traverse_1.default)(ctx.ast, {
            CallExpression(path) {
                if (calleeName(path.node.callee).split('.').at(-1) !== 'cors')
                    return;
                const options = path.node.arguments[0];
                if (!t.isObjectExpression(options))
                    return;
                const credentials = objectValue(options, 'credentials');
                const origin = objectValue(options, 'origin');
                const permissive = t.isBooleanLiteral(origin, { value: true }) ||
                    t.isStringLiteral(origin, { value: '*' }) ||
                    (t.isRegExpLiteral(origin) && origin.pattern === '.*');
                if (!t.isBooleanLiteral(credentials, { value: true }) || !permissive)
                    return;
                report(ctx, path.node, 'SEC-017', 'CWE-942', 'HIGH', 'CORS allows credentials with a wildcard or reflected request origin.', 'A permissive credentialed origin policy can let an attacker-controlled site issue authenticated cross-origin requests and read responses.', 'Use an exact allowlist of trusted HTTPS origins and reject all unmatched origins.');
            },
        });
    },
};
exports.APPLICATION_SECURITY_RULES = [
    exports.SensitiveLoggingRule,
    exports.UnverifiedJwtRule,
    exports.MassAssignmentRule,
    exports.InsecureSessionCookieRule,
    exports.PermissiveCorsRule,
];
