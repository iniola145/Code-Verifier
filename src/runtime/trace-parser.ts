import * as fs from "fs";
import { TraceEvent } from "./types";

/**
 * Parse a JSONL string into an array of trace events.
 */
export function parseTraceContent(content: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        events.push({
          type: parsed.type || "trace_event",
          ts: typeof parsed.ts === "number" ? parsed.ts : Date.now(),
          ...parsed,
        });
      }
    } catch {
      // Ignore malformed individual lines
    }
  }

  return events;
}

/**
 * Parse a JSONL trace file into trace events.
 */
export function parseTraceFile(filePath: string): TraceEvent[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return parseTraceContent(content);
}

/**
 * Extract line and column numbers from a stack trace or error message.
 */
function extractLocationFromStack(
  stack: string,
  filePath?: string,
): { line?: number; column?: number } {
  if (!stack) return {};
  if (filePath) {
    // Match filePath:line:column
    const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fileRegex = new RegExp(`${escaped}:(\\d+):(\\d+)`);
    const match = stack.match(fileRegex);
    if (match) {
      return { line: parseInt(match[1], 10), column: parseInt(match[2], 10) };
    }
  }

  // Fallback to generic line:col match (e.g. at ...:42:15)
  const genericMatch = stack.match(/:\s*(\d+):(\d+)\)?/);
  if (genericMatch) {
    return {
      line: parseInt(genericMatch[1], 10),
      column: parseInt(genericMatch[2], 10),
    };
  }

  return {};
}

/**
 * Parse Jest JSON output into trace events.
 */
export function parseJestOutput(jsonOutput: string): TraceEvent[] {
  let output: any;
  try {
    output = JSON.parse(jsonOutput);
  } catch {
    return [];
  }

  const events: TraceEvent[] = [];
  const now = Date.now();

  for (const suite of output.testResults || []) {
    const suitePath = suite.name || suite.testFilePath || "unknown";

    for (const test of suite.testResults || []) {
      if (test.status === "failed") {
        const failureMessages = test.failureMessages || [];
        const fullMessage = failureMessages.join("\n");
        const loc = extractLocationFromStack(fullMessage, suitePath);

        events.push({
          type: "assertion_failed",
          testName: test.fullName || test.title || "Unnamed Test",
          failureMessages,
          message: failureMessages[0] || "Assertion failed",
          filePath: suitePath,
          line: loc.line,
          column: loc.column,
          stack: fullMessage,
          duration: test.duration,
          ts: now,
        });
      }
    }

    // Extract console logs from Jest
    for (const consoleEntry of suite.console || []) {
      events.push({
        type: consoleEntry.type === "error" ? "console_error" : "console_log",
        message:
          typeof consoleEntry.message === "string"
            ? consoleEntry.message
            : JSON.stringify(consoleEntry.message),
        filePath: suitePath,
        ts: now,
      });
    }
  }

  return events;
}

/**
 * Parse JUnit XML output into trace events.
 */
export function parseJunitOutput(xmlOutput: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  const now = Date.now();

  // Parse <testcase ...> ... <failure ...>...</failure> </testcase>
  // Handles attributes with single or double quotes, self-closing tags, and nested elements
  const testcaseRegex =
    /<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gis;
  let tcMatch: RegExpExecArray | null;

  while ((tcMatch = testcaseRegex.exec(xmlOutput)) !== null) {
    const attrs = tcMatch[1] || "";
    const inner = tcMatch[2] || "";

    const nameMatch = attrs.match(/name="([^"]+)"/i);
    const classMatch = attrs.match(/classname="([^"]+)"/i);
    const fileMatch = attrs.match(/file="([^"]+)"/i);
    const lineMatch = attrs.match(/line="(\d+)"/i);

    const testName = nameMatch
      ? nameMatch[1]
      : classMatch
        ? classMatch[1]
        : "JUnit test";
    const filePath = fileMatch ? fileMatch[1] : "unknown";
    const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;

    // Check for failure or error inside testcase
    const failureMatch = inner.match(/<failure[^>]*>([\s\S]*?)<\/failure>/i);
    const errorMatch = inner.match(/<error[^>]*>([\s\S]*?)<\/error>/i);

    if (failureMatch || errorMatch) {
      const msg = (failureMatch ? failureMatch[1] : errorMatch![1]).trim();
      const loc = extractLocationFromStack(msg, filePath);

      events.push({
        type: "assertion_failed",
        testName,
        failureMessages: [msg],
        message: msg,
        filePath,
        line: line || loc.line,
        column: loc.column,
        ts: now,
      });
    }
  }

  // Fallback: If no testcase tags matched, try standalone <failure> tags
  if (events.length === 0) {
    const standaloneFailureRegex = /<failure[^>]*>([\s\S]*?)<\/failure>/gi;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = standaloneFailureRegex.exec(xmlOutput)) !== null) {
      const msg = sMatch[1].trim();
      events.push({
        type: "assertion_failed",
        testName: "JUnit failure",
        failureMessages: [msg],
        message: msg,
        filePath: "unknown",
        ts: now,
      });
    }
  }

  return events;
}
