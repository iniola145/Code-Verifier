# Phase 2D Specification: Selective Instrumentation

## Overview

This document is a self-contained specification for implementing Phase 2D of Code Verifier. The implementer should be able to execute this plan without additional context.

**Goal:** Inject runtime probes at specific flagged locations to detect runtime bugs that static analysis can't catch — without instrumenting the entire codebase.

**Deliverable:** `code-verifier --instrument ./src/ --output ./instrumented/` produces instrumented code with probes only at flagged locations.

---

## 1. The Problem

Static analysis finds *potential* bugs. But some bugs only manifest at runtime:
- Null dereferences that only happen with specific API responses
- Race conditions that only happen under specific timing
- State updates that only break under specific sequences

Phase 2D solves this by injecting **selective probes** at the exact locations where static analysis flagged potential issues. The probes:
- Record when the code path is executed
- Capture the actual values at the flagged location
- Report if the flagged condition actually occurs at runtime

---

## 2. File Structure

### New files to create

```
src/instrument/
  plugin.ts           — Babel plugin for selective instrumentation
  probe-templates.ts  — Probe code templates for each finding type
  runtime.ts          — Runtime probe functions injected into instrumented code
```

### Files to modify

```
src/cli.ts            — Add --instrument flag
src/runtime/runtime-engine.ts — Add instrumentation-specific rules
package.json          — No changes needed (uses existing exports)
```

---

## 3. Probe Templates (`src/instrument/probe-templates.ts`)

### Purpose

Generate probe code for each finding type.

### API

```typescript
/**
 * Generate probe code for a finding.
 */
export function generateProbe(
  finding: Diagnostic,
  location: { line: number; column: number },
): string;
```

### Probe types by finding

| Finding type | Probe code | What it captures |
|-------------|-----------|-----------------|
| `AI-NULL-001` | `__cv_probe_null("varName", varName, "L42")` | Actual value of variable at dereference point |
| `AI-TAINT-001` | `__cv_probe_taint("source", value, "sink")` | Untrusted value flowing to sink |
| `COMP-001` | `__cv_probe_props("Component", props)` | Props passed to component |
| `RACE-001` | `__cv_probe_async("operationId", () => { ... })` | Async operation timing |
| `ASYNC-001` | `__cv_probe_promise("promiseId", promise)` | Promise resolution/rejection |
| `SERVICE-001` | `__cv_probe_fetch("url", response)` | Fetch response status |

### Probe implementation

```typescript
export function generateProbe(
  finding: Diagnostic,
  location: { line: number; column: number },
): string {
  const loc = `L${location.line}`;
  
  switch (true) {
    case finding.ruleId.includes("NULL"):
      return `__cv_probe_null(${JSON.stringify(finding.message)}, ${loc});`;
    
    case finding.ruleId.includes("TAINT"):
      return `__cv_probe_taint(${JSON.stringify(finding.message)}, ${loc});`;
    
    case finding.ruleId.includes("COMP"):
      return `__cv_probe_props(${JSON.stringify(finding.message)}, ${loc});`;
    
    case finding.ruleId.includes("RACE"):
      return `__cv_probe_async(${JSON.stringify(finding.message)}, ${loc});`;
    
    case finding.ruleId.includes("ASYNC"):
      return `__cv_probe_promise(${JSON.stringify(finding.message)}, ${loc});`;
    
    case finding.ruleId.includes("SERVICE"):
      return `__cv_probe_fetch(${JSON.stringify(finding.message)}, ${loc});`;
    
    default:
      return `__cv_probe(${JSON.stringify(finding.ruleId)}, ${loc});`;
  }
}
```

---

## 4. Babel Plugin (`src/instrument/plugin.ts`)

### Purpose

Transform target code to inject probes at flagged locations.

### API

```typescript
/**
 * Babel plugin that injects probes at flagged locations.
 */
export default function codeVerifierInstrumentPlugin(): PluginObj;
```

### Implementation outline

```typescript
import { PluginObj } from "@babel/core";
import * as t from "@babel/types";
import { generateProbe } from "./probe-templates";

interface InstrumentOptions {
  findings: Diagnostic[];
  filePath: string;
}

export default function codeVerifierInstrumentPlugin(
  options: InstrumentOptions,
): PluginObj {
  const { findings, filePath } = options;
  
  // Group findings by line number
  const findingsByLine = new Map<number, Diagnostic[]>();
  for (const finding of findings) {
    const line = finding.loc.start.line;
    if (!findingsByLine.has(line)) {
      findingsByLine.set(line, []);
    }
    findingsByLine.get(line)!.push(finding);
  }

  return {
    name: "code-verifier-instrument",
    visitor: {
      // Inject probes at variable declarations
      VariableDeclaration(path) {
        const line = path.node.loc?.start.line;
        if (!line) return;
        
        const lineFindings = findingsByLine.get(line) || [];
        if (lineFindings.length === 0) return;
        
        // Add probe after the declaration
        for (const finding of lineFindings) {
          const probe = generateProbe(finding, { line, column: path.node.loc.start.column });
          const probeStmt = t.expressionStatement(
            t.identifier(probe)
          );
          path.insertAfter(probeStmt);
        }
      },
      
      // Inject probes at function calls
      CallExpression(path) {
        const line = path.node.loc?.start.line;
        if (!line) return;
        
        const lineFindings = findingsByLine.get(line) || [];
        if (lineFindings.length === 0) return;
        
        // Wrap the call with a probe
        for (const finding of lineFindings) {
          const probe = generateProbe(finding, { line, column: path.node.loc.start.column });
          // ... inject probe logic
        }
      },
      
      // Inject probes at return statements
      ReturnStatement(path) {
        const line = path.node.loc?.start.line;
        if (!line) return;
        
        const lineFindings = findingsByLine.get(line) || [];
        if (lineFindings.length === 0) return;
        
        // Add probe before the return
        for (const finding of lineFindings) {
          const probe = generateProbe(finding, { line, column: path.node.loc.start.column });
          // ... inject probe logic
        }
      },
    },
  };
}
```

---

## 5. Runtime Probe Functions (`src/instrument/runtime.ts`)

### Purpose

The runtime functions that probes call. These are injected into the instrumented code.

### Output

```typescript
// Code Verifier Runtime Probes
// This file is prepended to instrumented code

declare global {
  interface Window {
    __cv_probes: Array<{
      type: string;
      message: string;
      location: string;
      value?: any;
      timestamp: number;
    }>;
  }
}

window.__cv_probes = window.__cv_probes || [];

function __cv_record(type: string, message: string, location: string, value?: any) {
  window.__cv_probes.push({
    type,
    message,
    location,
    value,
    timestamp: Date.now(),
  });
}

function __cv_probe_null(message: string, location: string, value?: any) {
  if (value === null || value === undefined) {
    __cv_record("null_dereference", message, location, value);
  }
}

function __cv_probe_taint(message: string, location: string, value?: any) {
  __cv_record("taint_flow", message, location, value);
}

function __cv_probe_props(message: string, location: string, value?: any) {
  __cv_record("component_props", message, location, value);
}

function __cv_probe_async(message: string, location: string, operation?: () => Promise<any>) {
  const start = Date.now();
  return operation!().then(
    (result) => {
      __cv_record("async_success", message, location, { duration: Date.now() - start, result });
      return result;
    },
    (error) => {
      __cv_record("async_failure", message, location, { duration: Date.now() - start, error });
      throw error;
    }
  );
}

function __cv_probe_promise(message: string, location: string, promise?: Promise<any>) {
  return promise!.then(
    (result) => {
      __cv_record("promise_resolved", message, location, result);
      return result;
    },
    (error) => {
      __cv_record("promise_rejected", message, location, error);
      throw error;
    }
  );
}

function __cv_probe_fetch(message: string, location: string, response?: Response) {
  __cv_record("fetch_response", message, location, {
    status: response?.status,
    ok: response?.ok,
    url: response?.url,
  });
}

function __cv_probe(ruleId: string, location: string) {
  __cv_record("probe", ruleId, location);
}
```

---

## 6. CLI Integration (`src/cli.ts`)

### New flag

```bash
# Instrument code at flagged locations
code-verifier --instrument ./src/ --output ./instrumented/

# Instrument specific file
code-verifier --instrument ./src/api/client.ts --output ./instrumented/

# Instrument with custom probe output
code-verifier --instrument ./src/ --output ./instrumented/ --probe-output ./traces.jsonl
```

### CLI implementation outline

```typescript
// In src/cli.ts, add to arg parsing:
const instrumentFlag = getFlag(args, "--instrument");
const instrumentOutput = getFlag(args, "--output") || "./instrumented/";

if (instrumentFlag) {
  const target = instrumentFlag || targets[0];
  if (!target) {
    console.error("Error: No target specified for --instrument.");
    process.exit(1);
  }
  
  const resolvedTarget = path.resolve(target);
  if (!fs.existsSync(resolvedTarget)) {
    console.error(`Error: Target not found: ${target}`);
    process.exit(1);
  }
  
  // 1. Run static analysis to get findings
  const verifier = new CodeVerifier({ projectRoot: path.dirname(resolvedTarget) });
  const files = expandTargets([resolvedTarget]);
  
  const instrumentedFiles: Array<{ original: string; instrumented: string }> = [];
  
  for (const file of files) {
    const result = await verifier.verifyFile(file);
    
    if (result.diagnostics.length === 0) {
      // No findings — just copy the file
      instrumentedFiles.push({ original: file, instrumented: file });
      continue;
    }
    
    // 2. Parse the file
    const code = fs.readFileSync(file, "utf-8");
    const { ast } = parseSourceCode(code, file);
    
    // 3. Transform with Babel plugin
    const output = await transformAsync(code, {
      plugins: [codeVerifierInstrumentPlugin({ findings: result.diagnostics, filePath: file })],
      filename: file,
    });
    
    // 4. Prepend runtime probes
    const runtimeCode = fs.readFileSync(
      path.join(__dirname, "instrument/runtime.ts"),
      "utf-8"
    );
    
    const finalCode = `${runtimeCode}\n\n${output.code}`;
    
    // 5. Write instrumented file
    const relativePath = path.relative(path.dirname(resolvedTarget), file);
    const outputPath = path.join(instrumentOutput, relativePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, finalCode);
    
    instrumentedFiles.push({ original: file, instrumented: outputPath });
  }
  
  console.log(`Instrumented ${instrumentedFiles.length} file(s) in ${instrumentOutput}`);
  process.exit(0);
}
```

---

## 7. Runtime Engine Extension (`src/runtime/runtime-engine.ts`)

### Add instrumentation-specific rules

```typescript
// In analyzeRuntimeTraces, add handling for probe events:

case "null_dereference":
  findings.push({
    id: `RT-NULL-${idx}`,
    ruleId: "RT-NULL-001",
    severity: "HIGH",
    message: `Null dereference confirmed: ${event.message}`,
    filePath: event.filePath,
    loc: { start: { line: event.line || 1, column: 0 }, end: { line: event.line || 1, column: 10 } },
    trace: [event],
    confidence: "HIGH",
    confirmedBy: `probe at ${event.location}`,
  });
  break;

case "taint_flow":
  findings.push({
    id: `RT-TAINT-${idx}`,
    ruleId: "RT-TAINT-001",
    severity: "HIGH",
    message: `Taint flow confirmed: ${event.message}`,
    filePath: event.filePath,
    loc: { start: { line: event.line || 1, column: 0 }, end: { line: event.line || 1, column: 10 } },
    trace: [event],
    confidence: "HIGH",
    confirmedBy: `probe at ${event.location}`,
  });
  break;

case "async_failure":
  findings.push({
    id: `RT-ASYNC-${idx}`,
    ruleId: "RT-ASYNC-001",
    severity: "HIGH",
    message: `Async operation failed: ${event.message}`,
    filePath: event.filePath,
    loc: { start: { line: event.line || 1, column: 0 }, end: { line: event.line || 1, column: 10 } },
    trace: [event],
    confidence: "HIGH",
    confirmedBy: `probe at ${event.location}`,
  });
  break;
```

---

## 8. Acceptance Criteria

Phase 2D is complete when:

1. **Babel plugin works:** Given a file with an `AI-NULL-001` finding, the plugin injects a `__cv_probe_null` call at the flagged location.

2. **Probe templates work:** Each finding type generates the correct probe code.

3. **Runtime probes work:** The injected runtime functions record probe events to `window.__cv_probes`.

4. **CLI works end-to-end:** `code-verifier --instrument ./src/ --output ./instrumented/` produces instrumented files.

5. **Runtime engine handles probe events:** `analyzeRuntimeTraces` correctly processes `null_dereference`, `taint_flow`, and `async_failure` events.

6. **Instrumented code is valid:** The output is syntactically valid TypeScript/JSX that can be executed.

7. **No instrumentation when no findings:** Files without findings are copied unchanged.

---

## 9. Implementation Order

1. `src/instrument/probe-templates.ts` — Probe code generation
2. `src/instrument/runtime.ts` — Runtime probe functions
3. `src/instrument/plugin.ts` — Babel plugin
4. `src/runtime/runtime-engine.ts` — Add probe event handling
5. `src/cli.ts` — CLI integration

---

## 10. Review Checklist

After implementation, verify:

- [ ] All new files compile with `tsc`
- [ ] `npm test` still passes (existing tests not broken)
- [ ] Babel plugin injects probes at correct locations
- [ ] Probe templates generate correct code for each finding type
- [ ] Runtime probes record events correctly
- [ ] CLI `--instrument` flag works end-to-end
- [ ] Runtime engine handles probe events
- [ ] Instrumented code is syntactically valid
- [ ] Files without findings are unchanged
