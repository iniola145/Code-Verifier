import { Diagnostic, DiagnosticSeverity, RangeLocation } from "../types/verifier";

/** A runtime trace event */
export interface TraceEvent {
  type: string;
  ts: number;
  filePath?: string;
  testName?: string;
  failureMessages?: string[];
  message?: string;
  reason?: any;
  error?: any;
  stack?: string;
  line?: number;
  column?: number;
  [key: string]: any;
}

/** A confirmed runtime finding */
export interface RuntimeFinding {
  id: string;
  ruleId: string;
  severity: DiagnosticSeverity;
  message: string;
  filePath: string;
  loc: RangeLocation;
  trace: TraceEvent[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
  confirmedBy: string;
  staticFinding?: Diagnostic;
}

/** Options for runtime analysis */
export interface RuntimeAnalysisOptions {
  traceFile?: string;
  testCommand?: string;
  testOutputFormat?: "json" | "junit" | "verbose";
  correlateWithStatic?: boolean;
}

/** Unified analysis report combining static diagnostics and runtime findings */
export interface UnifiedAnalysisReport {
  staticFindings: Diagnostic[];
  runtimeFindings: RuntimeFinding[];
  summary: {
    totalStatic: number;
    totalRuntime: number;
    confirmedCount: number;
    newRuntimeCount: number;
  };
}
