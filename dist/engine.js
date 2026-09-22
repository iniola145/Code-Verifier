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
exports.CodeVerifier = void 0;
exports.collectFunctionRoots = collectFunctionRoots;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
const ast_1 = require("./parser/ast");
const builder_1 = require("./cfg/builder");
const fixpoint_1 = require("./abstract-interpreter/fixpoint");
const ts_types_1 = require("./abstract-interpreter/ts-types");
const domain_1 = require("./abstract-interpreter/domain");
const function_summaries_1 = require("./abstract-interpreter/function-summaries");
const baseline_1 = require("./baseline");
const symbols_1 = require("./abstract-interpreter/symbols");
const registry_1 = require("./rules/registry");
/** Extracts TypeScript-annotated nullable parameters as entry-state seeds. */
function collectParamSeeds(params, symbols) {
    const seeds = [];
    for (const p of params) {
        const seed = (0, ts_types_1.paramNullabilitySeed)(p);
        if (!seed)
            continue;
        const id = t.isIdentifier(p)
            ? p
            : t.isAssignmentPattern(p) && t.isIdentifier(p.left)
                ? p.left
                : null;
        if (id)
            seeds.push({ ...seed, key: symbols.key(id) });
    }
    return seeds;
}
/** Collects the module top level plus every function body as CFG roots. */
function collectFunctionRoots(ast, symbols = symbols_1.SymbolTable.fromAst(ast)) {
    const roots = [
        { name: '<module>', body: ast.program.body, paramSeeds: [] },
    ];
    (0, traverse_1.default)(ast, {
        'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod'(path) {
            const node = path.node;
            let name = '<anonymous>';
            if (t.isFunctionDeclaration(node) && node.id)
                name = node.id.name;
            else if (t.isObjectMethod(node) && t.isIdentifier(node.key))
                name = node.key.name;
            else if (t.isClassMethod(node) && t.isIdentifier(node.key))
                name = node.key.name;
            else if ('id' in node && node.id)
                name = node.id.name;
            else if (t.isVariableDeclarator(path.parent) && t.isIdentifier(path.parent.id)) {
                name = path.parent.id.name;
            }
            else if (t.isProperty(path.parent) && t.isIdentifier(path.parent.key)) {
                name = path.parent.key.name;
            }
            if (t.isBlockStatement(node.body)) {
                roots.push({ name, body: node.body.body, paramSeeds: collectParamSeeds(node.params, symbols) });
            }
            else if (node.body) {
                // Expression-bodied arrow: `() => expr` — synthesize a return.
                const ret = t.returnStatement(node.body);
                if (node.body.loc) {
                    ret.loc = { ...node.body.loc };
                }
                roots.push({ name, body: [ret], paramSeeds: collectParamSeeds(node.params, symbols) });
            }
        },
    });
    return roots;
}
/**
 * Filters diagnostics suppressed in-source:
 *   // code-verifier-disable-next-line
 *   // code-verifier-disable-file
 */
function applySuppressions(diagnostics, lines) {
    const suppressedLines = new Set();
    let fileSuppressed = false;
    const marker = /code-verifier-disable(?:-next-line|-file)?/;
    lines.forEach((line, idx) => {
        const m = line.match(marker);
        if (!m)
            return;
        if (m[0] === 'code-verifier-disable-file') {
            fileSuppressed = true;
        }
        else if (m[0] === 'code-verifier-disable-next-line') {
            suppressedLines.add(idx + 2); // 1-based next line
        }
        else {
            // bare `code-verifier-disable`: this line and the next
            suppressedLines.add(idx + 1);
            suppressedLines.add(idx + 2);
        }
    });
    if (fileSuppressed)
        return [];
    return diagnostics.filter((d) => !suppressedLines.has(d.loc.start.line));
}
const SEVERITY_RANK = {
    CRITICAL: 5,
    HIGH: 4,
    MEDIUM: 3,
    LOW: 2,
    INFO: 1,
};
class CodeVerifier {
    rules;
    enableAI;
    disabledRules;
    severityOverrides;
    projectSummaryIndex;
    baselineFingerprints;
    failOn;
    projectRoot;
    semanticAnalysisIndex;
    constructor(options) {
        this.rules = options?.rules || registry_1.REGISTERED_RULES;
        this.enableAI = options?.enableAbstractInterpretation ?? true;
        this.disabledRules = new Set(options?.disabledRules ?? []);
        this.severityOverrides = options?.severityOverrides ?? {};
        this.projectSummaryIndex = options?.projectSummaryIndex;
        this.baselineFingerprints = options?.baselineFingerprints ?? new Set();
        this.failOn = options?.failOn ?? 'MEDIUM';
        this.projectRoot = options?.projectRoot;
        this.semanticAnalysisIndex = options?.semanticAnalysisIndex;
    }
    /**
     * Verifies source code provided as a string.
     */
    async verifyCode(code, filePath = 'input.tsx') {
        const startTime = Date.now();
        const diagnostics = [];
        const checks = [];
        let ast;
        let lines;
        try {
            ({ ast, lines } = (0, ast_1.parseSourceCode)(code, filePath));
        }
        catch (err) {
            // A file that fails to parse must not kill a large-repo run — surface
            // it as a visible, non-blocking result instead.
            return parseFailureResult(filePath, code, Date.now() - startTime, err);
        }
        checks.push({ id: 'parser', name: 'Source parser', status: 'PASSED', required: true });
        const symbols = symbols_1.SymbolTable.fromAst(ast);
        // 1. Build one CFG per function body (+ module top level) and run
        //    abstract interpretation on each.
        const cfgs = [];
        const functionSummaries = this.projectSummaryIndex?.summariesForFile(ast, filePath) ?? new Map();
        for (const [name, summary] of (0, function_summaries_1.buildFunctionSummaries)(ast, functionSummaries))
            functionSummaries.set(name, summary);
        let truncatedCount = 0;
        let abstractAnalysisIncomplete = false;
        if (this.enableAI) {
            const interpreter = new fixpoint_1.AbstractInterpreter(functionSummaries, symbols);
            const crashedRoots = [];
            for (const root of collectFunctionRoots(ast, symbols)) {
                if (root.body.length === 0)
                    continue;
                let seedState;
                if (root.paramSeeds.length > 0) {
                    seedState = new Map();
                    for (const seed of root.paramSeeds) {
                        domain_1.MemoryState.set(seedState, seed.key, { nullability: seed.nullability });
                    }
                }
                try {
                    const cfg = new builder_1.CFGBuilder().build(root.body, root.name);
                    interpreter.analyze(cfg, seedState);
                    if (cfg.truncated)
                        truncatedCount++;
                    cfgs.push(cfg);
                }
                catch (err) {
                    // One pathological function must not lose the whole file's results.
                    crashedRoots.push(root.name);
                }
            }
            if (crashedRoots.length > 0) {
                abstractAnalysisIncomplete = true;
                diagnostics.push({
                    id: `${filePath}:0:0:AI-PERF-002`,
                    ruleId: 'AI-PERF-002',
                    category: 'CORRECTNESS',
                    severity: 'INFO',
                    message: `Abstract interpretation crashed on ${crashedRoots.length} function(s): ${crashedRoots
                        .slice(0, 5)
                        .map((n) => `\`${n}\``)
                        .join(', ')}${crashedRoots.length > 5 ? '…' : ''}.`,
                    explanation: 'The CFG construction or fixed-point solver threw on these functions. Other functions and all pattern rules completed normally.',
                    filePath,
                    loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
                    codeSnippet: '',
                    abstractInvariants: {},
                    remediation: {
                        summary: 'This is a verifier limitation, not a code issue.',
                        llmPromptHint: 'These functions were skipped by the abstract interpreter; pattern rules still applied.',
                    },
                });
            }
            checks.push({
                id: 'abstract-interpretation',
                name: 'Abstract interpretation',
                status: abstractAnalysisIncomplete ? 'INCOMPLETE' : 'PASSED',
                required: true,
                message: abstractAnalysisIncomplete
                    ? 'One or more functions could not be analyzed completely.'
                    : undefined,
            });
        }
        else {
            checks.push({
                id: 'abstract-interpretation',
                name: 'Abstract interpretation',
                status: 'SKIPPED',
                required: false,
                message: 'Disabled by configuration.',
            });
        }
        const context = {
            filePath,
            code,
            lines,
            ast,
            cfgs,
            symbols,
            functionSummaries,
            projectRoot: this.projectRoot,
            report: (d) => {
                diagnostics.push({
                    ...d,
                    filePath,
                });
            },
        };
        // 2. Run all rules — one broken rule on an odd node shape must not lose
        //    the other rules' findings for this file.
        let crashedRuleCount = 0;
        for (const rule of this.rules) {
            try {
                await rule.check(context);
            }
            catch (err) {
                crashedRuleCount++;
                diagnostics.push({
                    id: `${filePath}:0:0:${rule.id}-CRASH`,
                    ruleId: `${rule.id}-CRASH`,
                    category: 'CORRECTNESS',
                    severity: 'INFO',
                    message: `Rule ${rule.id} threw while analyzing this file: ${err?.message ?? err}`,
                    explanation: 'The rule crashed on this file. All other rules completed; this rule may have produced partial findings.',
                    filePath,
                    loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
                    codeSnippet: '',
                    abstractInvariants: {},
                    remediation: {
                        summary: 'This is a verifier bug, not a code issue — the other findings still stand.',
                        llmPromptHint: 'Ignore this entry; the rule id identifies the broken rule.',
                    },
                });
            }
        }
        checks.push({
            id: 'pattern-rules',
            name: 'Pattern rules',
            status: crashedRuleCount > 0 ? 'INCOMPLETE' : 'PASSED',
            required: true,
            message: crashedRuleCount > 0 ? `${crashedRuleCount} rule(s) crashed.` : undefined,
        });
        if (this.semanticAnalysisIndex) {
            diagnostics.push(...this.semanticAnalysisIndex.diagnosticsForFile(filePath));
            checks.push({ id: 'type-semantics', name: 'TypeScript semantic analysis', status: 'PASSED', required: true });
        }
        // 3. Surface abstract-interpretation truncation instead of failing silently
        for (const cfg of cfgs) {
            if (!cfg.truncated)
                continue;
            abstractAnalysisIncomplete = true;
            diagnostics.push({
                id: `${filePath}:0:0:AI-PERF-001`,
                ruleId: 'AI-PERF-001',
                category: 'CORRECTNESS',
                severity: 'INFO',
                message: `Abstract interpretation hit its iteration cap in ${cfg.name}; nullability results may be incomplete there.`,
                explanation: 'The fixed-point solver force-widens abstract states after repeated visits. If a function still exceeds the per-node visit cap, its analysis is stopped early and its invariants are conservative.',
                filePath,
                loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
                codeSnippet: extractTruncatedSnippet(cfg),
                abstractInvariants: {},
                remediation: {
                    summary: 'Simplify the loop structure, or raise the per-node visit cap for large generated loops.',
                    llmPromptHint: 'Be aware that abstract analysis of this function was truncated; re-verify after simplifying heavy loops.',
                },
            });
        }
        const abstractCheck = checks.find((check) => check.id === 'abstract-interpretation');
        if (abstractCheck && abstractAnalysisIncomplete) {
            abstractCheck.status = 'INCOMPLETE';
            abstractCheck.message = 'One or more functions crashed or reached the iteration limit.';
        }
        // 4. Apply in-source suppressions, config disables, severity overrides.
        const matchesDisabled = (ruleId) => {
            for (const disabled of this.disabledRules) {
                if (ruleId === disabled || ruleId.startsWith(disabled + '-'))
                    return true;
            }
            return false;
        };
        const fingerprintedDiagnostics = applySuppressions(diagnostics, lines)
            .filter((d) => !matchesDisabled(d.ruleId))
            .map((d) => this.severityOverrides[d.ruleId]
            ? { ...d, severity: this.severityOverrides[d.ruleId] }
            : d)
            .map((d) => ({ ...d, confidence: d.confidence ?? (0, registry_1.getRuleMetadata)(d.ruleId)?.confidence }))
            .map((d) => ({ ...d, fingerprint: (0, baseline_1.diagnosticFingerprint)(d, lines, this.projectRoot) }))
            .sort(compareDiagnostics);
        const finalDiagnostics = fingerprintedDiagnostics.filter((diagnostic) => !this.baselineFingerprints.has(diagnostic.fingerprint));
        const baselineSuppressed = fingerprintedDiagnostics.length - finalDiagnostics.length;
        const duration = Date.now() - startTime;
        // 5. Compute stats
        const issuesCount = {
            critical: finalDiagnostics.filter((d) => d.severity === 'CRITICAL').length,
            high: finalDiagnostics.filter((d) => d.severity === 'HIGH').length,
            medium: finalDiagnostics.filter((d) => d.severity === 'MEDIUM').length,
            low: finalDiagnostics.filter((d) => d.severity === 'LOW').length,
            info: finalDiagnostics.filter((d) => d.severity === 'INFO').length,
        };
        const isBlocking = (diagnostic) => SEVERITY_RANK[diagnostic.severity] >= SEVERITY_RANK[this.failOn];
        const hasBlockingFindings = finalDiagnostics.some(isBlocking);
        const hasIncompleteChecks = checks.some((check) => check.required && check.status === 'INCOMPLETE');
        const status = hasBlockingFindings ? 'FAILED' : hasIncompleteChecks ? 'INCOMPLETE' : 'PASSED';
        const passed = status === 'PASSED';
        const failingCount = finalDiagnostics.filter(isBlocking).length;
        return {
            filePath,
            status,
            passed,
            diagnostics: finalDiagnostics,
            checks,
            stats: {
                totalLines: lines.length,
                blocksAnalyzed: cfgs.reduce((sum, c) => sum + c.nodes.size, 0),
                rulesChecked: this.rules.length,
                executionTimeMs: duration,
                issuesCount,
                functionsAnalyzed: cfgs.length,
                truncatedFunctions: truncatedCount,
                baselineSuppressed,
            },
            summary: status === 'PASSED'
                ? `Verification Passed: No findings at or above ${this.failOn} across ${lines.length} lines (${cfgs.length} functions analyzed)${baselineSuppressed > 0 ? `; ${baselineSuppressed} baseline finding(s) suppressed` : ''}.`
                : status === 'FAILED'
                    ? `Verification Failed: Found ${failingCount} finding(s) at or above ${this.failOn} (${issuesCount.critical} Critical, ${issuesCount.high} High, ${issuesCount.medium} Medium, ${issuesCount.low} Low, ${issuesCount.info} Info).`
                    : `Verification Incomplete: No blocking findings, but one or more required checks did not complete.`,
        };
    }
    /**
     * Verifies a source file from filesystem.
     */
    async verifyFile(filePath) {
        const fullPath = path.resolve(filePath);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`File does not exist: ${fullPath}`);
        }
        const code = fs.readFileSync(fullPath, 'utf8');
        return this.verifyCode(code, fullPath);
    }
}
exports.CodeVerifier = CodeVerifier;
function compareDiagnostics(a, b) {
    return a.filePath.localeCompare(b.filePath) ||
        a.loc.start.line - b.loc.start.line ||
        a.loc.start.column - b.loc.start.column ||
        a.ruleId.localeCompare(b.ruleId) ||
        (a.fingerprint ?? '').localeCompare(b.fingerprint ?? '');
}
/** Result for a file whose parse failed — visible, but non-blocking (LOW). */
function parseFailureResult(filePath, code, durationMs, err) {
    const lines = code.split('\n');
    const message = String(err?.message ?? err).split('\n')[0];
    const locMatch = message.match(/ \((\d+):(\d+)\)/);
    const line = locMatch ? parseInt(locMatch[1], 10) : 1;
    return {
        filePath,
        status: 'INCOMPLETE',
        passed: false,
        diagnostics: [
            {
                id: `${filePath}:0:0:PARSE-001`,
                ruleId: 'PARSE-001',
                category: 'CORRECTNESS',
                severity: 'LOW',
                findingType: 'PARSE_ERROR',
                message: `File could not be parsed (${message})`,
                explanation: 'The file is not syntactically valid TypeScript/JavaScript (or uses syntax the parser does not support). Pattern rules and abstract interpretation did not run on it.',
                filePath,
                loc: { start: { line, column: 0 }, end: { line, column: 0 } },
                codeSnippet: lines[line - 1] ?? '',
                abstractInvariants: {},
                remediation: {
                    summary: 'Fix the syntax error, or add the file to the exclude list in .codeverifier.json.',
                    llmPromptHint: 'This file was skipped by analysis because it does not parse.',
                },
            },
        ],
        checks: [
            {
                id: 'parser',
                name: 'Source parser',
                status: 'INCOMPLETE',
                required: true,
                message,
            },
            {
                id: 'abstract-interpretation',
                name: 'Abstract interpretation',
                status: 'SKIPPED',
                required: true,
                message: 'Source parsing failed.',
            },
            {
                id: 'pattern-rules',
                name: 'Pattern rules',
                status: 'SKIPPED',
                required: true,
                message: 'Source parsing failed.',
            },
        ],
        stats: {
            totalLines: lines.length,
            failureType: 'parse-error',
            blocksAnalyzed: 0,
            rulesChecked: 0,
            executionTimeMs: durationMs,
            issuesCount: { critical: 0, high: 0, medium: 0, low: 1, info: 0 },
            functionsAnalyzed: 0,
            truncatedFunctions: 0,
        },
        summary: `Verification Skipped: file does not parse (${message})`,
    };
}
function extractTruncatedSnippet(cfg) {
    const loopNodes = [...cfg.nodes.values()].filter((n) => n.isLoopHeader);
    if (loopNodes.length > 0) {
        return `Function \`${cfg.name}\` — ${cfg.nodes.size} CFG blocks, loop header(s): ${loopNodes
            .map((n) => `#${n.id}`)
            .join(', ')}`;
    }
    return `Function \`${cfg.name}\` — ${cfg.nodes.size} CFG blocks`;
}
