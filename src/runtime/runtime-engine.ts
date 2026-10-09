import * as path from "path";
import { Diagnostic, DiagnosticSeverity, RangeLocation } from "../types/verifier";
import { RuntimeAnalysisOptions, RuntimeFinding, TraceEvent } from "./types";

function stripExtensionAndTest(p: string): string {
  return p
    .replace(/\.(test|spec)\.[a-zA-Z0-9]+$/, "")
    .replace(/\.[a-zA-Z0-9]+$/, "");
}

/**
 * Check if two file paths refer to the same file (handling relative vs absolute, extensions).
 */
function pathsMatch(pathA?: string, pathB?: string): boolean {
  if (!pathA || !pathB) return false;
  if (pathA === pathB) return true;
  const normA = stripExtensionAndTest(path.resolve(pathA));
  const normB = stripExtensionAndTest(path.resolve(pathB));
  if (normA === normB) return true;

  const baseA = stripExtensionAndTest(path.basename(pathA));
  const baseB = stripExtensionAndTest(path.basename(pathB));
  return baseA === baseB;
}

/**
 * Find matching static diagnostic for a trace event.
 */
function findMatchingStaticDiagnostic(
  event: TraceEvent,
  staticFindings?: Diagnostic[],
): Diagnostic | undefined {
  if (!staticFindings || staticFindings.length === 0) return undefined;

  const fullText = `${event.testName || ""} ${event.message || ""} ${(event.failureMessages || []).join(" ")}`;

  // 1. Direct rule ID match in test name or message (e.g. "Covers AI-NULL-001" or "RN-SEC-001")
  for (const finding of staticFindings) {
    if (fullText.includes(finding.ruleId)) {
      if (!event.filePath || pathsMatch(event.filePath, finding.filePath)) {
        return finding;
      }
    }
  }

  // 2. Line number proximity match in the same file
  if (event.filePath && event.line) {
    const fileMatches = staticFindings.filter((f) =>
      pathsMatch(event.filePath, f.filePath),
    );
    for (const finding of fileMatches) {
      const lineDiff = Math.abs(finding.loc.start.line - event.line);
      if (lineDiff <= 3) {
        return finding;
      }
    }
  }

  // 3. Fallback: match by file if only 1 finding in that file
  if (event.filePath) {
    const fileMatches = staticFindings.filter((f) =>
      pathsMatch(event.filePath, f.filePath),
    );
    if (fileMatches.length === 1) {
      return fileMatches[0];
    }
  }

  return undefined;
}

/**
 * Analyze runtime trace events and produce confirmed findings.
 */
export function analyzeRuntimeTraces(
  traceEvents: TraceEvent[],
  staticFindings?: Diagnostic[],
  options?: RuntimeAnalysisOptions,
): RuntimeFinding[] {
  const findings: RuntimeFinding[] = [];
  const correlate = options?.correlateWithStatic !== false;

  for (let idx = 0; idx < traceEvents.length; idx++) {
    const event = traceEvents[idx];
    const fullText = `${event.testName || ""} ${event.message || ""} ${(event.failureMessages || []).join(" ")}`;

    const matchingStatic = correlate
      ? findMatchingStaticDiagnostic(event, staticFindings)
      : undefined;

    const loc: RangeLocation = matchingStatic?.loc || {
      start: { line: event.line || 1, column: event.column || 0 },
      end: { line: event.line || 1, column: (event.column || 0) + 10 },
    };

    const filePath =
      matchingStatic?.filePath || event.filePath || "unknown";

    // Detect specialized failure signatures
    const isNullDereference =
      /cannot read propert|null dereference|is null|is undefined|undefined is not an object|AI-NULL-001/i.test(
        fullText,
      );

    const isUnhandledRejection =
      event.type === "unhandled_rejection" ||
      /unhandled promise rejection|unhandledrejection|rejected promise|ASYNC-001|ASYNC-002/i.test(
        fullText,
      );

    const isRaceCondition =
      /race condition|out of order|concurrent|RACE-/i.test(fullText);

    let ruleId: string;
    let severity: DiagnosticSeverity = "HIGH";
    let message: string;
    let confirmedBy: string;

    if (matchingStatic) {
      // Confirmed static finding
      if (isNullDereference || matchingStatic.ruleId.includes("NULL")) {
        ruleId = "RT-CONFIRM-002";
        message = `Confirmed null dereference: ${matchingStatic.message}`;
      } else if (
        isUnhandledRejection ||
        matchingStatic.ruleId.startsWith("ASYNC")
      ) {
        ruleId = "RT-CONFIRM-003";
        message = `Confirmed unhandled promise rejection: ${matchingStatic.message}`;
      } else if (
        isRaceCondition ||
        matchingStatic.ruleId.startsWith("RACE")
      ) {
        ruleId = "RT-CONFIRM-004";
        message = `Confirmed race condition: ${matchingStatic.message}`;
      } else {
        ruleId = "RT-CONFIRM-001";
        message = `Confirmed static finding (${matchingStatic.ruleId}): ${matchingStatic.message}`;
      }

      severity = matchingStatic.severity;
      confirmedBy = event.testName || event.type;
    } else {
      // New runtime bug not flagged statically
      ruleId = "RT-NEW-001";
      if (event.type === "unhandled_rejection") {
        message = `Unhandled rejection: ${event.reason || event.message || "Promise rejected"}`;
        severity = "HIGH";
        confirmedBy = "unhandledRejection";
      } else if (event.type === "console_error") {
        message = `Console error: ${event.message || "Runtime console error"}`;
        severity = "MEDIUM";
        confirmedBy = "console.error";
      } else {
        message = `Test assertion failed: ${event.testName || event.message || "Assertion error"}`;
        severity = "HIGH";
        confirmedBy = event.testName || "test runner";
      }
    }

    findings.push({
      id: `${ruleId}-${idx + 1}-${event.testName ? event.testName.replace(/[^a-zA-Z0-9_-]/g, "_") : event.ts}`,
      ruleId,
      severity,
      message,
      filePath,
      loc,
      trace: [event],
      confidence: "HIGH",
      confirmedBy,
      staticFinding: matchingStatic,
    });
  }

  return findings;
}
