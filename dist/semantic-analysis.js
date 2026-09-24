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
exports.SemanticAnalysisIndex = void 0;
const path = __importStar(require("path"));
const typescript_1 = __importDefault(require("typescript"));
/** Project-wide TypeScript checker used for rules that cannot be soundly inferred from syntax alone. */
class SemanticAnalysisIndex {
    program;
    checker;
    static fromFiles(files) {
        const roots = files.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
        const program = typescript_1.default.createProgram(roots, {
            target: typescript_1.default.ScriptTarget.ES2022,
            module: typescript_1.default.ModuleKind.CommonJS,
            moduleResolution: typescript_1.default.ModuleResolutionKind.Node10,
            jsx: typescript_1.default.JsxEmit.Preserve,
            allowJs: true,
            checkJs: false,
            noEmit: true,
            skipLibCheck: true,
        });
        return new SemanticAnalysisIndex(program);
    }
    constructor(program) {
        this.program = program;
        this.checker = program.getTypeChecker();
    }
    diagnosticsForFile(filePath) {
        const source = this.program.getSourceFile(path.resolve(filePath));
        if (!source ||
            source.isDeclarationFile ||
            /\.[cm]?jsx?$/.test(source.fileName))
            return [];
        const diagnostics = [];
        const visit = (node) => {
            if (typescript_1.default.isExpressionStatement(node) &&
                !typescript_1.default.isVoidExpression(node.expression) &&
                this.isPromiseLike(node.expression) &&
                !this.hasRejectionHandler(node.expression)) {
                // MEDIUM, not HIGH: fire-and-forget UI helpers (haptics, toasts,
                // analytics) are idiomatic and would otherwise drown real findings.
                diagnostics.push(this.makeDiagnostic(source, node.expression, "TYPE-001", "MEDIUM", "A Promise-returning expression is not awaited, returned, voided, or rejection-handled.", "The operation can continue after its caller and a rejection can become unhandled.", "Await or return the Promise, attach a rejection handler, or explicitly use void when fire-and-forget is intentional."));
            }
            const condition = typescript_1.default.isConditionalExpression(node)
                ? node.condition
                : typescript_1.default.isIfStatement(node) ||
                    typescript_1.default.isWhileStatement(node) ||
                    typescript_1.default.isDoStatement(node)
                    ? node.expression
                    : null;
            if (condition && this.isPromiseLike(condition)) {
                diagnostics.push(this.makeDiagnostic(source, condition, "TYPE-002", "HIGH", "A Promise is used directly as a boolean condition.", "Promise objects are always truthy, so this condition does not test the eventual boolean result.", "Await the Promise before evaluating its resolved value."));
            }
            typescript_1.default.forEachChild(node, visit);
        };
        visit(source);
        return diagnostics;
    }
    isPromiseLike(node) {
        const type = this.checker.getTypeAtLocation(node);
        if (type.flags &
            (typescript_1.default.TypeFlags.Any | typescript_1.default.TypeFlags.Unknown | typescript_1.default.TypeFlags.Never))
            return false;
        return type.isUnion()
            ? type.types.some((member) => this.isThenableType(member, node))
            : this.isThenableType(type, node);
    }
    isThenableType(type, node) {
        const then = type.getProperty("then");
        if (!then)
            return false;
        return (this.checker.getTypeOfSymbolAtLocation(then, node).getCallSignatures()
            .length > 0);
    }
    hasRejectionHandler(node) {
        if (!typescript_1.default.isCallExpression(node) ||
            !typescript_1.default.isPropertyAccessExpression(node.expression))
            return false;
        const method = node.expression.name.text;
        return (method === "catch" || (method === "then" && node.arguments.length >= 2));
    }
    makeDiagnostic(source, node, ruleId, severity, message, explanation, remediation) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source));
        const end = source.getLineAndCharacterOfPosition(node.getEnd());
        return {
            id: `${source.fileName}:${start.line + 1}:${start.character}:${ruleId}`,
            ruleId,
            category: "CORRECTNESS",
            severity,
            message,
            explanation,
            filePath: source.fileName,
            loc: {
                start: { line: start.line + 1, column: start.character },
                end: { line: end.line + 1, column: end.character },
            },
            codeSnippet: source.text.slice(node.getStart(source), node.getEnd()),
            remediation: { summary: remediation, llmPromptHint: remediation },
        };
    }
}
exports.SemanticAnalysisIndex = SemanticAnalysisIndex;
