import * as fs from 'fs';
import * as path from 'path';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { parseSourceCode } from './parser/ast';
import { CFGBuilder } from './cfg/builder';
import { AbstractInterpreter } from './abstract-interpreter/fixpoint';
import { paramNullabilitySeed } from './abstract-interpreter/ts-types';
import { MemoryState } from './abstract-interpreter/domain';
import { buildFunctionSummaries } from './abstract-interpreter/function-summaries';
import { ProjectSummaryIndex } from './abstract-interpreter/project-summaries';
import { diagnosticFingerprint } from './baseline';
import { SemanticAnalysisIndex } from './semantic-analysis';
import { ImportGraphIndex } from './unused-files';
import { ProjectUiIndex } from './project-ui-index';
import { SymbolTable } from './abstract-interpreter/symbols';
import { REGISTERED_RULES, getRuleMetadata } from './rules/registry';
import {
  Diagnostic,
  VerificationResult,
  VerificationRule,
  RuleContext,
  CFG,
  NullabilityValue,
  MemoryAbstractState,
  VerificationCheck,
} from './types/verifier';

export interface VerifierOptions {
  rules?: VerificationRule[];
  enableAbstractInterpretation?: boolean;
  disabledRules?: string[];
  severityOverrides?: Record<string, string>;
  projectSummaryIndex?: ProjectSummaryIndex;
  baselineFingerprints?: ReadonlySet<string>;
  failOn?: Diagnostic['severity'];
  projectRoot?: string;
  semanticAnalysisIndex?: SemanticAnalysisIndex;
  importGraphIndex?: ImportGraphIndex;
  projectUiIndex?: ProjectUiIndex;
}

interface FunctionRoot {
  name: string;
  body: t.Statement[];
  paramSeeds: { name: string; key: string; nullability: NullabilityValue }[];
}

/** Extracts TypeScript-annotated nullable parameters as entry-state seeds. */
function collectParamSeeds(params: t.Function['params'], symbols: SymbolTable): FunctionRoot['paramSeeds'] {
  const seeds: FunctionRoot['paramSeeds'] = [];
  for (const p of params) {
    const seed = paramNullabilitySeed(p);
    if (!seed) continue;
    const id = t.isIdentifier(p)
      ? p
      : t.isAssignmentPattern(p) && t.isIdentifier(p.left)
        ? p.left
        : null;
    if (id) seeds.push({ ...seed, key: symbols.key(id) });
  }
  return seeds;
}

/** Collects the module top level plus every function body as CFG roots. */
export function collectFunctionRoots(ast: t.File, symbols = SymbolTable.fromAst(ast)): FunctionRoot[] {
  const roots: FunctionRoot[] = [
    { name: '<module>', body: ast.program.body, paramSeeds: [] },
  ];

  traverse(ast, {
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod'(
      path: any
    ) {
      const node = path.node as t.Function;
      let name = '<anonymous>';
      if (t.isFunctionDeclaration(node) && node.id) name = node.id.name;
      else if (t.isObjectMethod(node) && t.isIdentifier(node.key)) name = node.key.name;
      else if (t.isClassMethod(node) && t.isIdentifier(node.key)) name = node.key.name;
      else if ('id' in node && node.id) name = (node.id as t.Identifier).name;
      else if (t.isVariableDeclarator(path.parent) && t.isIdentifier(path.parent.id)) {
        name = path.parent.id.name;
      } else if (t.isProperty(path.parent) && t.isIdentifier(path.parent.key)) {
        name = path.parent.key.name;
      }

      if (t.isBlockStatement(node.body)) {
        roots.push({ name, body: node.body.body, paramSeeds: collectParamSeeds(node.params, symbols) });
      } else if (node.body) {
        // Expression-bodied arrow: `() => expr` — synthesize a return.
        const ret = t.returnStatement(node.body as t.Expression);
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
function applySuppressions(diagnostics: Diagnostic[], lines: string[]): Diagnostic[] {
  const suppressedLines = new Set<number>();
  let fileSuppressed = false;

  const marker = /code-verifier-disable(?:-next-line|-file)?/;
  lines.forEach((line, idx) => {
    const m = line.match(marker);
    if (!m) return;
    if (m[0] === 'code-verifier-disable-file') {
      fileSuppressed = true;
    } else if (m[0] === 'code-verifier-disable-next-line') {
      suppressedLines.add(idx + 2); // 1-based next line
    } else {
      // bare `code-verifier-disable`: this line and the next
      suppressedLines.add(idx + 1);
      suppressedLines.add(idx + 2);
    }
  });

  if (fileSuppressed) return [];
  return diagnostics.filter((d) => !suppressedLines.has(d.loc.start.line));
}

const SEVERITY_RANK: Record<Diagnostic['severity'], number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
};

export class CodeVerifier {
  private rules: VerificationRule[];
  private enableAI: boolean;
  private disabledRules: Set<string>;
  private severityOverrides: Record<string, string>;
  private projectSummaryIndex?: ProjectSummaryIndex;
  private baselineFingerprints: ReadonlySet<string>;
  private failOn: Diagnostic['severity'];
  private projectRoot?: string;
  private semanticAnalysisIndex?: SemanticAnalysisIndex;
  private importGraphIndex?: ImportGraphIndex;
  private projectUiIndex?: ProjectUiIndex;

  constructor(options?: VerifierOptions) {
    this.rules = options?.rules || REGISTERED_RULES;
    this.enableAI = options?.enableAbstractInterpretation ?? true;
    this.disabledRules = new Set(options?.disabledRules ?? []);
    this.severityOverrides = options?.severityOverrides ?? {};
    this.projectSummaryIndex = options?.projectSummaryIndex;
    this.baselineFingerprints = options?.baselineFingerprints ?? new Set();
    this.failOn = options?.failOn ?? 'MEDIUM';
    this.projectRoot = options?.projectRoot;
    this.semanticAnalysisIndex = options?.semanticAnalysisIndex;
    this.importGraphIndex = options?.importGraphIndex;
    this.projectUiIndex = options?.projectUiIndex;
  }

  /**
   * Verifies source code provided as a string.
   */
  public async verifyCode(code: string, filePath = 'input.tsx'): Promise<VerificationResult> {
    const startTime = Date.now();
    const diagnostics: Diagnostic[] = [];
    const checks: VerificationCheck[] = [];

    let ast: t.File;
    let lines: string[];
    try {
      ({ ast, lines } = parseSourceCode(code, filePath));
    } catch (err: any) {
      // A file that fails to parse must not kill a large-repo run — surface
      // it as a visible, non-blocking result instead.
      return parseFailureResult(filePath, code, Date.now() - startTime, err);
    }
    checks.push({ id: 'parser', name: 'Source parser', status: 'PASSED', required: true });
    const symbols = SymbolTable.fromAst(ast);

    // 1. Build one CFG per function body (+ module top level) and run
    //    abstract interpretation on each.
    const cfgs: CFG[] = [];
    const functionSummaries = this.projectSummaryIndex?.summariesForFile(ast, filePath) ?? new Map();
    const projectFunctionBehaviors = this.projectSummaryIndex?.behaviorsForFile(ast, filePath) ?? new Map();
    const projectSchemaTypes = this.projectUiIndex?.schemaTypesForFile(ast, filePath) ?? new Map();
    const projectStyleObjects = this.projectUiIndex?.styleObjectsForFile(ast, filePath) ?? new Map();
    const projectComponentContracts = this.projectUiIndex?.componentContractsForFile(ast, filePath) ?? new Map();
    for (const [name, summary] of buildFunctionSummaries(ast, functionSummaries)) functionSummaries.set(name, summary);
    let truncatedCount = 0;
    let abstractAnalysisIncomplete = false;

    if (this.enableAI) {
      const interpreter = new AbstractInterpreter(functionSummaries, symbols);
      const crashedRoots: string[] = [];
      for (const root of collectFunctionRoots(ast, symbols)) {
        if (root.body.length === 0) continue;
        let seedState: MemoryAbstractState | undefined;
        if (root.paramSeeds.length > 0) {
          seedState = new Map();
          for (const seed of root.paramSeeds) {
            MemoryState.set(seedState, seed.key, { nullability: seed.nullability });
          }
        }
        try {
          const cfg = new CFGBuilder().build(root.body, root.name);
          interpreter.analyze(cfg, seedState);
          if (cfg.truncated) truncatedCount++;
          cfgs.push(cfg);
        } catch (err: any) {
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
          explanation:
            'The CFG construction or fixed-point solver threw on these functions. Other functions and all pattern rules completed normally.',
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
    } else {
      checks.push({
        id: 'abstract-interpretation',
        name: 'Abstract interpretation',
        status: 'SKIPPED',
        required: false,
        message: 'Disabled by configuration.',
      });
    }

    const context: RuleContext = {
      filePath,
      code,
      lines,
      ast,
      cfgs,
      symbols,
      functionSummaries,
      projectFunctionBehaviors,
      projectSchemaTypes,
      projectStyleObjects,
      projectComponentContracts,
      projectUiIndex: this.projectUiIndex,
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
      } catch (err: any) {
        crashedRuleCount++;
        diagnostics.push({
          id: `${filePath}:0:0:${rule.id}-CRASH`,
          ruleId: `${rule.id}-CRASH`,
          category: 'CORRECTNESS',
          severity: 'INFO',
          message: `Rule ${rule.id} threw while analyzing this file: ${err?.message ?? err}`,
          explanation:
            'The rule crashed on this file. All other rules completed; this rule may have produced partial findings.',
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

    // 2b. Project-wide orphan-file check: needs the whole-project import
    //     graph, which is built once in the CLI and passed in as an index.
    if (this.importGraphIndex && !this.importGraphIndex.isReachable(filePath)) {
      diagnostics.push({
        id: `${filePath}:0:0:HYG-004`,
        ruleId: 'HYG-004',
        category: 'CORRECTNESS',
        severity: 'LOW',
        message: `File is never imported by any other file in the project.`,
        explanation:
          'Nothing references this file — it is dead code that still costs review time, type-checking, and (unless tree-shaken) bundle size. Entry points, config files, tests, stories, and route directories are exempt.',
        filePath,
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        codeSnippet: lines.length > 0 ? lines[0].slice(0, 120) : '',
        remediation: {
          summary: 'Delete the file, import it where intended, or wire it into an entry point.',
          llmPromptHint: 'This file is never imported anywhere in the project. Remove it, or import/wire it where it was meant to be used.',
        },
      });
    }

    // 3. Surface abstract-interpretation truncation instead of failing silently
    for (const cfg of cfgs) {
      if (!cfg.truncated) continue;
      abstractAnalysisIncomplete = true;
      diagnostics.push({
        id: `${filePath}:0:0:AI-PERF-001`,
        ruleId: 'AI-PERF-001',
        category: 'CORRECTNESS',
        severity: 'INFO',
        message: `Abstract interpretation hit its iteration cap in ${cfg.name}; nullability results may be incomplete there.`,
        explanation:
          'The fixed-point solver force-widens abstract states after repeated visits. If a function still exceeds the per-node visit cap, its analysis is stopped early and its invariants are conservative.',
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
    const matchesDisabled = (ruleId: string): boolean => {
      for (const disabled of this.disabledRules) {
        if (ruleId === disabled || ruleId.startsWith(disabled + '-')) return true;
      }
      return false;
    };
    const fingerprintedDiagnostics = applySuppressions(diagnostics, lines)
      .filter((d) => !matchesDisabled(d.ruleId))
      .map((d) =>
        this.severityOverrides[d.ruleId]
          ? { ...d, severity: this.severityOverrides[d.ruleId] as Diagnostic['severity'] }
          : d
      )
      .map((d) => ({ ...d, confidence: d.confidence ?? getRuleMetadata(d.ruleId)?.confidence }))
      .map((d) => ({ ...d, fingerprint: diagnosticFingerprint(d, lines, this.projectRoot) }))
      .sort(compareDiagnostics);
    const finalDiagnostics = fingerprintedDiagnostics.filter(
      (diagnostic) => !this.baselineFingerprints.has(diagnostic.fingerprint!)
    );
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

    const isBlocking = (diagnostic: Diagnostic) =>
      SEVERITY_RANK[diagnostic.severity] >= SEVERITY_RANK[this.failOn];
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
  public async verifyFile(filePath: string): Promise<VerificationResult> {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File does not exist: ${fullPath}`);
    }
    const code = fs.readFileSync(fullPath, 'utf8');
    return this.verifyCode(code, fullPath);
  }
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return a.filePath.localeCompare(b.filePath) ||
    a.loc.start.line - b.loc.start.line ||
    a.loc.start.column - b.loc.start.column ||
    a.ruleId.localeCompare(b.ruleId) ||
    (a.fingerprint ?? '').localeCompare(b.fingerprint ?? '');
}

/** Result for a file whose parse failed — visible, but non-blocking (LOW). */
function parseFailureResult(
  filePath: string,
  code: string,
  durationMs: number,
  err: any
): VerificationResult {
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
        explanation:
          'The file is not syntactically valid TypeScript/JavaScript (or uses syntax the parser does not support). Pattern rules and abstract interpretation did not run on it.',
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

function extractTruncatedSnippet(cfg: CFG): string {
  const loopNodes = [...cfg.nodes.values()].filter((n) => n.isLoopHeader);
  if (loopNodes.length > 0) {
    return `Function \`${cfg.name}\` — ${cfg.nodes.size} CFG blocks, loop header(s): ${loopNodes
      .map((n) => `#${n.id}`)
      .join(', ')}`;
  }
  return `Function \`${cfg.name}\` — ${cfg.nodes.size} CFG blocks`;
}
