import * as fs from "fs";
import * as path from "path";
import { TraceEvent } from "../runtime/types";

/**
 * Jest reporter that captures test execution data and traces for Code Verifier.
 * Usage in jest.config.js:
 *   reporters: ['default', 'code-verifier/jest-reporter']
 */
export default class CodeVerifierReporter {
  private globalConfig: any;
  private options: any;
  private results: Map<string, any> = new Map();
  private traceEvents: TraceEvent[] = [];

  constructor(globalConfig?: any, options?: any) {
    this.globalConfig = globalConfig || {};
    this.options = options || {};
  }

  onTestResult(test: any, testResult: any): void {
    const filePath = test?.path || testResult?.testFilePath || "unknown";

    // 1. Capture failed test assertions
    for (const result of testResult?.testResults || []) {
      if (result.status === "failed") {
        const failureMessages = result.failureMessages || [];
        this.traceEvents.push({
          type: "assertion_failed",
          testName: result.fullName || result.title || "Unknown Test",
          failureMessages,
          message: failureMessages[0] || "Assertion failed",
          filePath,
          duration: result.duration,
          ts: Date.now(),
        });
      }
    }

    // 2. Capture console errors reported by Jest
    for (const entry of testResult?.console || []) {
      if (entry.type === "error") {
        this.traceEvents.push({
          type: "console_error",
          message:
            typeof entry.message === "string"
              ? entry.message
              : JSON.stringify(entry.message),
          filePath,
          origin: entry.origin,
          ts: Date.now(),
        });
      }
    }

    // 3. Store aggregated results per test file
    this.results.set(filePath, {
      numPassingTests: testResult?.numPassingTests ?? 0,
      numFailingTests: testResult?.numFailingTests ?? 0,
      testResults: (testResult?.testResults || []).map((r: any) => ({
        fullName: r.fullName || r.title,
        status: r.status,
        duration: r.duration,
      })),
    });
  }

  onRunComplete(contexts: any, results: any): void {
    const outputFile =
      this.options?.outputFile || process.env.CODE_VERIFIER_TRACE_FILE;

    if (outputFile) {
      try {
        const dir = path.dirname(outputFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const jsonlContent = this.traceEvents
          .map((e) => JSON.stringify(e))
          .join("\n");
        fs.writeFileSync(outputFile, jsonlContent, "utf-8");
      } catch (err: any) {
        process.stderr.write(
          `[code-verifier] Failed to write trace file: ${err?.message || err}\n`,
        );
      }
    }

    // Print summary to stderr
    if (this.traceEvents.length > 0) {
      process.stderr.write(
        `\n[code-verifier] ${this.traceEvents.length} trace event(s) captured\n`,
      );
    }
  }

  getResults(): Map<string, any> {
    return this.results;
  }

  getTraceEvents(): TraceEvent[] {
    return this.traceEvents;
  }
}

// CommonJS compatibility for Jest's custom reporter loader
if (typeof module !== "undefined" && module.exports) {
  module.exports = CodeVerifierReporter;
  (CodeVerifierReporter as any).default = CodeVerifierReporter;
}
