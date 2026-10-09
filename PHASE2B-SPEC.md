# Phase 2B Specification: Test Runner Integration

## Overview

This document is a self-contained specification for implementing Phase 2B of Code Verifier. The implementer should be able to execute this plan without additional context.

**Goal:** Hook into the user's existing test runner (Jest/Vitest) to capture runtime data and correlate it with static analysis findings.

**Deliverable:** `code-verifier --with-jest --jest-config jest.config.js` runs tests and produces a unified static + runtime report.

---

## 1. File Structure

### New files to create

```
src/adapters/
  jest-reporter.ts      — Jest reporter (compiled to dist/adapters/jest-reporter.js)
  vitest-plugin.ts      — Vitest plugin (compiled to dist/adapters/vitest-plugin.js)
  jest-setup.ts         — Jest setup file for error capture (compiled to dist/adapters/jest-setup.js)
src/runtime/
  trace-parser.ts       — Parse JSONL trace files
  runtime-engine.ts     — Runtime rule runner
  types.ts              — Runtime-specific types
```

### Files to modify

```
package.json            — Add exports subpaths for adapters
src/cli.ts              — Add --with-jest, --with-vitest, --runtime-traces flags
src/mcp-server.ts       — Add get_runtime_findings tool
src/formatter/llm-formatter.ts — Handle runtime diagnostics
```

---

## 2. Type Definitions (`src/runtime/types.ts`)

```typescript
import { DiagnosticSeverity, RangeLocation } from "../types/verifier";

/** A runtime trace event */
export interface TraceEvent {
  type: string;
  ts: number;
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
  confidence: "HIGH";
  confirmedBy: string;
}

/** Options for runtime analysis */
export interface RuntimeAnalysisOptions {
  traceFile?: string;
  testCommand?: string;
  testOutputFormat?: "json" | "junit" | "verbose";
  correlateWithStatic?: boolean;
}
```

---

## 3. Jest Reporter (`src/adapters/jest-reporter.ts`)

### Purpose

Captures test execution data from Jest and correlates it with static analysis findings.

### API

```typescript
/**
 * Jest reporter that captures test results for Code Verifier analysis.
 * Usage: reporters: ['default', 'code-verifier/jest-reporter']
 */
export default class CodeVerifierReporter {
  private results: Map<string, any>;

  constructor(globalConfig: any, options?: any);

  onTestResult(test: any, testResult: any): void;
  onRunComplete(contexts: any, results: any): void;
  getResults(): Map<string, any>;
}
```

### Implementation outline

```typescript
import { TraceEvent } from "../runtime/types";

export default class CodeVerifierReporter {
  private results: Map<string, any> = new Map();
  private traceEvents: TraceEvent[] = [];

  onTestResult(test: any, testResult: any) {
    const filePath = test.path;

    // Capture failed assertions
    for (const result of testResult.testResults) {
      if (result.status === "failed") {
        this.traceEvents.push({
          type: "assertion_failed",
          testName: result.fullName,
          failureMessages: result.failureMessages,
          filePath,
          ts: Date.now(),
        });
      }
    }

    // Capture console errors
    for (const entry of testResult.console || []) {
      if (entry.type === "error") {
        this.traceEvents.push({
          type: "console_error",
          message: entry.message,
          filePath,
          ts: Date.now(),
        });
      }
    }

    this.results.set(filePath, {
      numPassingTests: testResult.numPassingTests,
      numFailingTests: testResult.numFailingTests,
      testResults: testResult.testResults.map((r: any) => ({
        fullName: r.fullName,
        status: r.status,
        duration: r.duration,
      })),
    });
  }

  onRunComplete(contexts: any, results: any) {
    // Output trace events to stderr for capture
    process.stderr.write(
      `\n[code-verifier] ${this.traceEvents.length} trace events captured\n`
    );
  }

  getResults(): Map<string, any> {
    return this.results;
  }

  getTraceEvents(): TraceEvent[] {
    return this.traceEvents;
  }
}
```

---

## 4. Vitest Plugin (`src/adapters/vitest-plugin.ts`)

### Purpose

Captures test execution data from Vitest.

### API

```typescript
/**
 * Vitest plugin that captures test results for Code Verifier analysis.
 * Usage: plugins: [codeVerifierPlugin()]
 */
export default function codeVerifierPlugin(): any;
```

### Implementation outline

```typescript
import { TraceEvent } from "../runtime/types";

export default function codeVerifierPlugin(): any {
  const traceEvents: TraceEvent[] = [];

  return {
    name: "code-verifier",
    enforce: "post" as const,

    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        next();
      });
    },

    transform(code: string, id: string) {
      if (id.includes(".test.") || id.includes(".spec.")) {
        return injectErrorCapture(code, id);
      }
      return code;
    },
  };
}

function injectErrorCapture(code: string, id: string): string {
  return `
    process.on('unhandledRejection', (reason) => {
      console.error('[code-verifier] unhandledRejection:', reason);
    });
    ${code}
  `;
}
```

---

## 5. Jest Setup File (`src/adapters/jest-setup.ts`)

### Purpose

Captures runtime errors that occur during test execution.

### Output

```typescript
// Code Verifier Jest Setup
// Add to jest.config.js: setupFilesAfterEnv: ['code-verifier/jest-setup']

const originalError = console.error;
console.error = (...args: any[]) => {
  if (typeof (globalThis as any).__cv_captureError === "function") {
    (globalThis as any).__cv_captureError(args);
  }
  originalError.apply(console, args);
};

process.on("unhandledRejection", (reason: any) => {
  if (typeof (globalThis as any).__cv_captureRejection === "function") {
    (globalThis as any).__cv_captureRejection(reason);
  }
});
```

---

## 6. Trace Parser (`src/runtime/trace-parser.ts`)

### Purpose

Parse JSONL trace files or captured test output into structured trace events.

### API

```typescript
import { TraceEvent } from "./types";

/**
 * Parse a JSONL trace file into trace events.
 */
export function parseTraceFile(filePath: string): TraceEvent[];

/**
 * Parse Jest JSON output into trace events.
 */
export function parseJestOutput(jsonOutput: string): TraceEvent[];

/**
 * Parse JUnit XML output into trace events.
 */
export function parseJunitOutput(xmlOutput: string): TraceEvent[];
```

### Implementation outline

```typescript
import * as fs from "fs";
import { TraceEvent } from "./types";

export function parseTraceFile(filePath: string): TraceEvent[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function parseJestOutput(jsonOutput: string): TraceEvent[] {
  const output = JSON.parse(jsonOutput);
  const events: TraceEvent[] = [];

  for (const suite of output.testResults || []) {
    for (const test of suite.testResults || []) {
      if (test.status === "failed") {
        events.push({
          type: "assertion_failed",
          testName: test.fullName,
          failureMessages: test.failureMessages,
          filePath: suite.name,
          ts: Date.now(),
        });
      }
    }
  }

  return events;
}

export function parseJunitOutput(xmlOutput: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  // Parse JUnit XML using regex or a simple XML parser
  const failureRegex = /<failure[^>]*>([^<]*)<\/failure>/g;
  let match;
  while ((match = failureRegex.exec(xmlOutput)) !== null) {
    events.push({
      type: "assertion_failed",
      testName: "JUnit test",
      failureMessages: [match[1]],
      filePath: "unknown",
      ts: Date.now(),
    });
  }
  return events;
}
```

---

## 7. Runtime Engine (`src/runtime/runtime-engine.ts`)

### Purpose

Consume trace events and produce confirmed runtime findings.

### API

```typescript
import { Diagnostic } from "../types/verifier";
import { RuntimeFinding, RuntimeAnalysisOptions, TraceEvent } from "./types";

/**
 * Analyze runtime trace events and produce confirmed findings.
 */
export function analyzeRuntimeTraces(
  traceEvents: TraceEvent[],
  staticFindings?: Diagnostic[],
  options?: RuntimeAnalysisOptions
): RuntimeFinding[];
```

### Runtime rules

| Rule ID | What it confirms | How |
|---------|-----------------|-----|
| `RT-CONFIRM-001` | Static finding is real | Test fails at the exact location static analysis flagged |
| `RT-CONFIRM-002` | Null dereference happened | Trace shows null value at dereference point |
| `RT-CONFIRM-003` | Unhandled rejection occurred | Trace shows rejection with no catch handler |
| `RT-CONFIRM-004` | Race condition manifested | Trace shows out-of-order async completion |
| `RT-NEW-001` | New bug not found statically | Runtime error with no corresponding static finding |

### Implementation outline

```typescript
import { Diagnostic, DiagnosticSeverity } from "../types/verifier";
import { RuntimeFinding, TraceEvent } from "./types";

export function analyzeRuntimeTraces(
  traceEvents: TraceEvent[],
  staticFindings?: Diagnostic[],
): RuntimeFinding[] {
  const findings: RuntimeFinding[] = [];

  for (const event of traceEvents) {
    switch (event.type) {
      case "assertion_failed":
        findings.push(handleAssertionFailed(event, staticFindings));
        break;
      case "console_error":
        findings.push(handleConsoleError(event, staticFindings));
        break;
      case "unhandled_rejection":
        findings.push(handleUnhandledRejection(event, staticFindings));
        break;
    }
  }

  return findings;
}

function handleAssertionFailed(
  event: TraceEvent,
  staticFindings?: Diagnostic[],
): RuntimeFinding {
  const matchingStatic = staticFindings?.find(
    (d) => d.filePath === event.filePath,
  );

  return {
    id: `RT-CONFIRM-${event.testName}`,
    ruleId: matchingStatic?.ruleId || "RT-NEW-001",
    severity: (matchingStatic?.severity || "HIGH") as DiagnosticSeverity,
    message: `Test failed: ${event.testName}`,
    filePath: event.filePath,
    loc: matchingStatic?.loc || { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
    trace: [event],
    confidence: "HIGH",
    confirmedBy: event.testName,
  };
}

function handleConsoleError(
  event: TraceEvent,
  staticFindings?: Diagnostic[],
): RuntimeFinding {
  return {
    id: `RT-CONFIRM-console-${event.ts}`,
    ruleId: "RT-NEW-001",
    severity: "MEDIUM",
    message: `Console error: ${event.message}`,
    filePath: event.filePath,
    loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
    trace: [event],
    confidence: "HIGH",
    confirmedBy: "console.error",
  };
}

function handleUnhandledRejection(
  event: TraceEvent,
  staticFindings?: Diagnostic[],
): RuntimeFinding {
  return {
    id: `RT-CONFIRM-rejection-${event.ts}`,
    ruleId: "RT-NEW-001",
    severity: "HIGH",
    message: `Unhandled rejection: ${event.reason}`,
    filePath: event.filePath,
    loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
    trace: [event],
    confidence: "HIGH",
    confirmedBy: "unhandledRejection",
  };
}
```

---

## 8. Package Exports (`package.json`)

### Add exports subpaths

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./jest-reporter": "./dist/adapters/jest-reporter.js",
    "./vitest-plugin": "./dist/adapters/vitest-plugin.js",
    "./jest-setup": "./dist/adapters/jest-setup.js"
  }
}
```

---

## 9. CLI Integration (`src/cli.ts`)

### New flags

```bash
# Run with Jest integration
code-verifier --with-jest --jest-config jest.config.js ./src/

# Run with Vitest integration
code-verifier --with-vitest --vitest-config vitest.config.ts ./src/

# Analyze runtime traces
code-verifier --runtime-traces trace.jsonl --correlate ./src/

# Run tests and correlate
code-verifier --run-tests --test-command "npm test" ./src/
```

### CLI implementation outline

```typescript
// In src/cli.ts, add to arg parsing:
const withJest = args.includes("--with-jest");
const withVitest = args.includes("--with-vitest");
const runtimeTracesFlag = getFlag(args, "--runtime-traces");
const runTests = args.includes("--run-tests");

if (withJest || withVitest || runtimeTracesFlag || runTests) {
  // Run tests with instrumentation
  const traceEvents = runtimeTracesFlag
    ? parseTraceFile(runtimeTracesFlag)
    : await runTestsWithCapture({
        framework: withJest ? "jest" : "vitest",
        config: getFlag(args, "--jest-config") || getFlag(args, "--vitest-config"),
        targets,
      });

  // Run static analysis
  const staticResults = await runStaticAnalysis(targets);
  const allStaticDiagnostics = staticResults.flatMap(r => r.diagnostics);

  // Correlate
  const runtimeFindings = analyzeRuntimeTraces(traceEvents, allStaticDiagnostics);

  // Output unified report
  outputUnifiedReport(staticResults, runtimeFindings, format);

  process.exit(0);
}
```

---

## 10. MCP Integration (`src/mcp-server.ts`)

### New tool

```typescript
// tools/list returns:
{
  name: "get_runtime_findings",
  description: "Get runtime findings from a trace file. Returns confirmed bugs with evidence.",
  inputSchema: {
    type: "object",
    properties: {
      traceFile: {
        type: "string",
        description: "Path to JSONL trace file",
      },
      staticResultsFile: {
        type: "string",
        description: "Optional path to static analysis results JSON",
      },
    },
    required: ["traceFile"],
  },
}
```

### Handler

```typescript
if (toolName === "get_runtime_findings") {
  const { traceFile, staticResultsFile } = params;

  const traces = parseTraceFile(traceFile);
  const staticFindings = staticResultsFile
    ? JSON.parse(fs.readFileSync(staticResultsFile, "utf-8"))
    : undefined;

  const findings = analyzeRuntimeTraces(traces, staticFindings);

  this.sendResponse(id, {
    content: [{ type: "text", text: JSON.stringify(findings, null, 2) }],
    isError: false,
  });
  return;
}
```

---

## 11. Formatter Extension (`src/formatter/llm-formatter.ts`)

### Handle runtime diagnostics

```typescript
export function formatRuntimeFindings(findings: RuntimeFinding[]): string {
  return findings
    .map((f) => {
      return `### ${f.ruleId}: ${f.message}

**Severity:** ${f.severity}
**File:** ${f.filePath}:${f.loc.start.line}
**Confidence:** ${f.confidence}
**Confirmed by:** ${f.confirmedBy}

**Trace:**
${f.trace.map((e) => `  - ${e.type}: ${JSON.stringify(e)}`).join("\n")}
`;
    })
    .join("\n\n");
}
```

---

## 12. Acceptance Criteria

Phase 2B is complete when:

1. **Jest reporter works:** Given a Jest project, `reporters: ['default', 'code-verifier/jest-reporter']` captures test failures.
2. **Vitest plugin works:** Given a Vitest project, `plugins: [codeVerifierPlugin()]` captures test failures.
3. **Trace parser works:** `parseTraceFile("trace.jsonl")` returns an array of `TraceEvent[]`.
4. **Runtime engine works:** `analyzeRuntimeTraces(traces, staticFindings)` returns confirmed findings.
5. **CLI works end-to-end:** `code-verifier --with-jest --jest-config jest.config.js ./src/` runs tests and produces unified report.
6. **MCP tool works:** Calling `get_runtime_findings` via MCP returns runtime findings.
7. **Package exports work:** `require('code-verifier/jest-reporter')` resolves correctly.

---

## 13. Implementation Order

1. `src/runtime/types.ts` — Runtime type definitions
2. `src/runtime/trace-parser.ts` — Trace parsing
3. `src/runtime/runtime-engine.ts` — Runtime analysis engine
4. `src/adapters/jest-reporter.ts` — Jest reporter
5. `src/adapters/vitest-plugin.ts` — Vitest plugin
6. `src/adapters/jest-setup.ts` — Jest setup file
7. `package.json` — Add exports subpaths
8. `src/cli.ts` — CLI integration
9. `src/mcp-server.ts` — MCP integration
10. `src/formatter/llm-formatter.ts` — Formatter extension

---

## 14. Review Checklist

After implementation, verify:

- [ ] All new files compile with `tsc`
- [ ] `npm test` still passes (existing tests not broken)
- [ ] Jest reporter captures test failures
- [ ] Vitest plugin captures test failures
- [ ] Trace parser handles JSONL, Jest JSON, and JUnit XML
- [ ] Runtime engine correlates traces with static findings
- [ ] CLI `--with-jest` flag works end-to-end
- [ ] MCP `get_runtime_findings` tool returns findings
- [ ] Package exports resolve correctly
- [ ] `package.json` has correct exports subpaths
