import type { SymbolTable } from "../abstract-interpreter/symbols";
import type { FunctionSummary } from "../abstract-interpreter/function-summaries";
import type { ProjectFunctionBehavior } from "../abstract-interpreter/project-summaries";
import type { ComponentContractFact, ProjectUiIndex, SchemaTypeFact, StyleObjectFact } from "../project-ui-index";

export type DiagnosticCategory =
  | "SECURITY"
  | "CORRECTNESS"
  | "PERFORMANCE"
  | "REACT_HOOKS"
  | "REACT_NATIVE_EXPO";

export type DiagnosticSeverity =
  | "CRITICAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "INFO";
export type DiagnosticConfidence = "HIGH" | "MEDIUM" | "LOW";
export type VerificationStatus = "PASSED" | "FAILED" | "INCOMPLETE";
export type CheckStatus = "PASSED" | "FAILED" | "INCOMPLETE" | "SKIPPED";
export type AnalysisRequirement =
  | "AST"
  | "CFG"
  | "ABSTRACT_INTERPRETATION"
  | "TYPE_INFORMATION"
  | "PROJECT_CONTEXT";
export type SupportedFramework =
  | "TYPESCRIPT"
  | "REACT"
  | "WEB"
  | "REACT_NATIVE"
  | "EXPO";

export interface SourceLocation {
  line: number;
  column: number;
}

export interface RangeLocation {
  start: SourceLocation;
  end: SourceLocation;
}

export interface DiagnosticRemediation {
  summary: string;
  suggestedFix?: string;
  llmPromptHint: string;
}

export interface Diagnostic {
  id: string;
  ruleId: string;
  cweId?: string;
  findingType?: string;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  confidence?: DiagnosticConfidence;
  message: string;
  explanation: string;
  filePath: string;
  loc: RangeLocation;
  codeSnippet: string;
  abstractInvariants?: Record<string, string>;
  remediation: DiagnosticRemediation;
  /** Stable across line movement and absolute checkout locations. */
  fingerprint?: string;
}

export interface VerificationCheck {
  id: string;
  name: string;
  status: CheckStatus;
  required: boolean;
  message?: string;
}

export interface ProjectCheck extends VerificationCheck {
  command?: string;
  durationMs: number;
  exitCode?: number | null;
  output?: string;
}

export interface ProjectVerificationResult {
  projectRoot: string;
  status: VerificationStatus;
  checks: ProjectCheck[];
  summary: string;
}

export interface RuleMetadata {
  id: string;
  name: string;
  description: string;
  category: DiagnosticCategory;
  defaultSeverity: DiagnosticSeverity;
  confidence: DiagnosticConfidence;
  requirements: AnalysisRequirement[];
  frameworks: SupportedFramework[];
  cweId?: string;
  documentationUrl?: string;
}

export interface VerificationStats {
  totalLines: number;
  blocksAnalyzed: number;
  rulesChecked: number;
  executionTimeMs: number;
  functionsAnalyzed?: number;
  truncatedFunctions?: number;
  failureType?: "parse-error" | null;
  baselineSuppressed?: number;
  issuesCount: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
}

export interface VerificationResult {
  filePath: string;
  status: VerificationStatus;
  /** Backward-compatible convenience: true only when status is PASSED. */
  passed: boolean;
  diagnostics: Diagnostic[];
  checks: VerificationCheck[];
  stats: VerificationStats;
  summary: string;
}

// ==========================================
// Abstract Interpretation Lattice Types
// ==========================================

export type NullabilityValue =
  | "Bottom" // Unreachable / no value
  | "NonNull" // Definitely not null/undefined
  | "Null" // Definitely null
  | "Undefined" // Definitely undefined
  | "Nullable" // Can be null, undefined, or value
  | "Top"; // Unknown

export interface IntervalValue {
  min: number; // can be -Infinity
  max: number; // can be Infinity
}

export interface TaintValue {
  isTainted: boolean;
  sources: string[];
}

export interface VariableAbstractState {
  interval?: IntervalValue;
  nullability: NullabilityValue;
  taint: TaintValue;
}

export type MemoryAbstractState = Map<string, VariableAbstractState>;

// ==========================================
// Control Flow Graph (CFG) Types
// ==========================================

export interface CFGNode {
  id: number;
  label: string;
  statements: any[]; // Babel AST statements or expressions
  predecessors: number[];
  successors: number[];
  condition?: any;
  isLoopHeader?: boolean;
  stateIn: MemoryAbstractState;
  stateOut: MemoryAbstractState;
}

/**
 * A path condition attached to a CFG edge. When the fixpoint computes a
 * node's input state, it refines each predecessor's output state according
 * to the branch taken (e.g. the true edge of `if (x === null)` proves x is
 * null on that path).
 */
export interface EdgeCondition {
  test: any; // Babel expression guarding this edge
  polarity: boolean; // true = edge taken when test is truthy
}

export interface CFG {
  entryNodeId: number;
  exitNodeId: number;
  nodes: Map<number, CFGNode>;
  statementStates?: Map<any, MemoryAbstractState>;
  edgeConditions?: Map<string, EdgeCondition>; // keyed `${fromId}->${toId}`
  name?: string; // function / scope this CFG was built for
  truncated?: boolean; // analysis hit its iteration cap; results imprecise
}

// ==========================================
// Rule Context & Interface
// ==========================================

export interface RuleContext {
  filePath: string;
  code: string;
  lines: string[];
  ast: any;
  cfgs: CFG[]; // one CFG per function body + the module top level
  symbols: SymbolTable;
  functionSummaries: Map<string, FunctionSummary>;
  /** Behaviors proven for functions imported from another analyzed project file. */
  projectFunctionBehaviors: Map<string, ProjectFunctionBehavior>;
  projectSchemaTypes: Map<string, SchemaTypeFact>;
  projectStyleObjects: Map<string, StyleObjectFact>;
  projectComponentContracts: Map<string, ComponentContractFact>;
  projectUiIndex?: ProjectUiIndex;
  /** Project root, when known — lets path-convention rules (e.g. Expo Router) resolve files precisely. */
  projectRoot?: string;
  report: (diagnostic: Omit<Diagnostic, "filePath">) => void;
}

export interface VerificationRule {
  id: string;
  name: string;
  description: string;
  category: DiagnosticCategory;
  defaultSeverity: DiagnosticSeverity;
  cweId?: string;
  check: (context: RuleContext) => void | Promise<void>;
}
