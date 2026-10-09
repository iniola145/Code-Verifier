# Phase 2C Specification: MCP Test-and-Fix Loop

## Overview

This document is a self-contained specification for implementing Phase 2C of Code Verifier. The implementer should be able to execute this plan without additional context.

**Goal:** Expose test generation and verification to LLM agents via MCP, enabling the TDR (Test-Driven Remediation) loop: verify → generate test → test fails → fix → verify fix.

**Deliverable:** LLM agents can call `generate_tests`, run the tests, and call `verify_fix` to confirm the fix works — all via MCP.

---

## 1. The TDR Agent Loop

The greatest commercial and practical value of Phase 2 is enabling **autonomous self-healing for LLM coding agents**. This loop should be explicit in the MCP surface design:

1. **Agent Step 1:** Call `verify_code` → receives finding `AI-NULL-001` or `COMP-001`.
2. **Agent Step 2:** Call `generate_tests` → receives a minimal, reproducible test case.
3. **Agent Step 3:** Agent runs the test (or calls the test runner) → **Test fails (Red)**, proving the bug is real.
4. **Agent Step 4:** Agent modifies the source code to fix the issue.
5. **Agent Step 5:** Call `verify_fix` → static engine confirms the finding is cleared AND the generated test passes **(Green)**.

This gives AI agents (Cursor, Claude, Gemini, Antigravity) the ability to verify their own fixes with mathematical and empirical certainty.

---

## 2. File Structure

### New files to create

```
src/tdr/
  session-manager.ts    — Manages TDR sessions (stateful, file-based)
  fix-verifier.ts       — Verifies that a fix resolves a finding
```

### Files to modify

```
src/mcp-server.ts       — Add verify_fix, start_tdr_session, get_tdr_status tools
src/cli.ts              — Add --verify-fix, --tdr-session flags
src/formatter/llm-formatter.ts — Handle TDR session output
```

---

## 3. TDR Session Manager (`src/tdr/session-manager.ts`)

### Purpose

Manages the state of a TDR session. Since MCP is stateless, sessions are file-based.

### API

```typescript
/**
 * A TDR session.
 */
export interface TDRSession {
  id: string;
  createdAt: string;
  sourceFile: string;
  originalFindings: Diagnostic[];
  generatedTests: GeneratedTest[];
  status: "pending" | "tests_generated" | "tests_failing" | "fixed" | "verified";
  fixCommit?: string;
  verificationResult?: VerificationResult;
}

/**
 * Create a new TDR session.
 */
export function createSession(
  sourceFile: string,
  findings: Diagnostic[],
  tests: GeneratedTest[],
): TDRSession;

/**
 * Load a TDR session from disk.
 */
export function loadSession(sessionId: string): TDRSession | null;

/**
 * Save a TDR session to disk.
 */
export function saveSession(session: TDRSession): void;

/**
 * List all TDR sessions.
 */
export function listSessions(): TDRSession[];

/**
 * Update a TDR session.
 */
export function updateSession(
  sessionId: string,
  updates: Partial<TDRSession>,
): TDRSession | null;
```

### Implementation outline

```typescript
import * as fs from "fs";
import * as path from "path";
import { Diagnostic, VerificationResult } from "../types/verifier";
import { GeneratedTest } from "../test-gen/types";

const SESSION_DIR = path.join(process.cwd(), ".verifier", "sessions");

export function createSession(
  sourceFile: string,
  findings: Diagnostic[],
  tests: GeneratedTest[],
): TDRSession {
  const id = `tdr-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const session: TDRSession = {
    id,
    createdAt: new Date().toISOString(),
    sourceFile,
    originalFindings: findings,
    generatedTests: tests,
    status: "tests_generated",
  };
  saveSession(session);
  return session;
}

export function loadSession(sessionId: string): TDRSession | null {
  const filePath = path.join(SESSION_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function saveSession(session: TDRSession): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
  const filePath = path.join(SESSION_DIR, `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
}

export function listSessions(): TDRSession[] {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), "utf-8")));
}

export function updateSession(
  sessionId: string,
  updates: Partial<TDRSession>,
): TDRSession | null {
  const session = loadSession(sessionId);
  if (!session) return null;
  const updated = { ...session, ...updates };
  saveSession(updated);
  return updated;
}
```

---

## 4. Fix Verifier (`src/tdr/fix-verifier.ts`)

### Purpose

Verifies that a fix resolves a finding by:
1. Running static analysis on the fixed code
2. Checking if the original finding is still present
3. Optionally running the generated test to confirm it passes

### API

```typescript
/**
 * Verify that a fix resolves a finding.
 */
export async function verifyFix(
  sourceFile: string,
  originalFindings: Diagnostic[],
  options?: {
    runTests?: boolean;
    testCommand?: string;
  },
): Promise<FixVerificationResult>;
```

### Types

```typescript
export interface FixVerificationResult {
  fixed: boolean;
  remainingFindings: Diagnostic[];
  resolvedFindings: Diagnostic[];
  newFindings: Diagnostic[];
  testResult?: {
    passed: boolean;
    output: string;
  };
}
```

### Implementation outline

```typescript
import { CodeVerifier } from "../engine";
import { Diagnostic } from "../types/verifier";
import { execSync } from "child_process";

export async function verifyFix(
  sourceFile: string,
  originalFindings: Diagnostic[],
  options?: {
    runTests?: boolean;
    testCommand?: string;
  },
): Promise<FixVerificationResult> {
  // 1. Run static analysis on the fixed code
  const verifier = new CodeVerifier();
  const result = await verifier.verifyFile(sourceFile);

  // 2. Check which original findings are resolved
  const resolvedFindings: Diagnostic[] = [];
  const remainingFindings: Diagnostic[] = [];

  for (const original of originalFindings) {
    const stillPresent = result.diagnostics.some(
      (d) => d.ruleId === original.ruleId && d.loc.start.line === original.loc.start.line,
    );
    if (stillPresent) {
      remainingFindings.push(original);
    } else {
      resolvedFindings.push(original);
    }
  }

  // 3. Check for new findings
  const newFindings = result.diagnostics.filter(
    (d) => !originalFindings.some((o) => o.ruleId === d.ruleId && o.loc.start.line === d.loc.start.line),
  );

  // 4. Optionally run tests
  let testResult: { passed: boolean; output: string } | undefined;
  if (options?.runTests) {
    try {
      const output = execSync(options.testCommand || "npm test", {
        cwd: path.dirname(sourceFile),
        encoding: "utf-8",
        stdio: "pipe",
      });
      testResult = { passed: true, output };
    } catch (err: any) {
      testResult = {
        passed: false,
        output: err.stdout ? String(err.stdout) : err.message,
      };
    }
  }

  return {
    fixed: remainingFindings.length === 0,
    remainingFindings,
    resolvedFindings,
    newFindings,
    testResult,
  };
}
```

---

## 5. MCP Integration (`src/mcp-server.ts`)

### New tools

```typescript
// tools/list returns:
{
  name: "verify_fix",
  description: "Verify that a fix resolves a finding. Returns verification result.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "TDR session ID",
      },
      sourceFile: {
        type: "string",
        description: "Source file that was fixed",
      },
      runTests: {
        type: "boolean",
        description: "Whether to run tests to verify the fix",
        default: true,
      },
    },
    required: ["sessionId", "sourceFile"],
  },
},
{
  name: "start_tdr_session",
  description: "Start a TDR session. Returns session ID and generated tests.",
  inputSchema: {
    type: "object",
    properties: {
      sourceFile: {
        type: "string",
        description: "Source file to analyze",
      },
      framework: {
        type: "string",
        enum: ["jest", "vitest", "detox"],
        description: "Test framework",
      },
    },
    required: ["sourceFile"],
  },
},
{
  name: "get_tdr_status",
  description: "Get the status of a TDR session.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "TDR session ID",
      },
    },
    required: ["sessionId"],
  },
}
```

### Handlers

```typescript
if (toolName === "start_tdr_session") {
  const { sourceFile, framework } = args;

  // 1. Run static analysis
  const result = await this.verifier.verifyCode(
    fs.readFileSync(sourceFile, "utf-8"),
    sourceFile,
  );

  // 2. Generate tests
  const tests = await generateTestsForFile(sourceFile, {
    framework: framework as TestFramework | undefined,
    mode: "directory",
  });

  // 3. Create session
  const session = createSession(sourceFile, result.diagnostics, [tests]);

  this.sendResponse(id, {
    content: [{
      type: "text",
      text: JSON.stringify({
        sessionId: session.id,
        status: session.status,
        findings: session.originalFindings,
        generatedTests: tests.content,
      }, null, 2),
    }],
    isError: false,
  });
  return;
}

if (toolName === "verify_fix") {
  const { sessionId, sourceFile, runTests } = args;

  // 1. Load session
  const session = loadSession(sessionId);
  if (!session) {
    this.sendResponse(id, {
      content: [{ type: "text", text: "Session not found" }],
      isError: true,
    });
    return;
  }

  // 2. Verify fix
  const result = await verifyFix(sourceFile, session.originalFindings, {
    runTests: runTests !== false,
  });

  // 3. Update session
  updateSession(sessionId, {
    status: result.fixed ? "verified" : "fixed",
    verificationResult: result,
  });

  this.sendResponse(id, {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2),
    }],
    isError: !result.fixed,
  });
  return;
}

if (toolName === "get_tdr_status") {
  const { sessionId } = args;
  const session = loadSession(sessionId);

  if (!session) {
    this.sendResponse(id, {
      content: [{ type: "text", text: "Session not found" }],
      isError: true,
    });
    return;
  }

  this.sendResponse(id, {
    content: [{ type: "text", text: JSON.stringify(session, null, 2) }],
    isError: false,
  });
  return;
}
```

---

## 6. CLI Integration (`src/cli.ts`)

### New flags

```bash
# Start a TDR session
code-verifier --start-tdr ./src/AuthScreen.tsx

# Verify a fix
code-verifier --verify-fix --session-id tdr-1234567890-abcd12 ./src/AuthScreen.tsx

# Get TDR session status
code-verifier --tdr-status tdr-1234567890-abcd12
```

### CLI implementation outline

```typescript
const startTDR = args.includes("--start-tdr");
const verifyFixFlag = args.includes("--verify-fix");
const tdrStatus = getFlag(args, "--tdr-status");
const sessionId = getFlag(args, "--session-id");

if (startTDR) {
  const target = targets[0];
  const result = await verifier.verifyCode(fs.readFileSync(target, "utf-8"), target);
  const tests = await generateTestsForFile(target, { mode: "directory" });
  const session = createSession(target, result.diagnostics, [tests]);
  console.log(`TDR Session: ${session.id}`);
  console.log(`Status: ${session.status}`);
  console.log(`Findings: ${session.originalFindings.length}`);
  console.log(`Tests: ${tests.content}`);
  process.exit(0);
}

if (verifyFixFlag) {
  const target = targets[0];
  const session = loadSession(sessionId);
  if (!session) {
    console.error("Session not found");
    process.exit(1);
  }
  const result = await verifyFix(target, session.originalFindings, { runTests: true });
  console.log(`Fixed: ${result.fixed}`);
  console.log(`Resolved: ${result.resolvedFindings.length}`);
  console.log(`Remaining: ${result.remainingFindings.length}`);
  console.log(`New: ${result.newFindings.length}`);
  process.exit(result.fixed ? 0 : 1);
}

if (tdrStatus) {
  const session = loadSession(tdrStatus);
  if (!session) {
    console.error("Session not found");
    process.exit(1);
  }
  console.log(JSON.stringify(session, null, 2));
  process.exit(0);
}
```

---

## 7. Formatter Extension (`src/formatter/llm-formatter.ts`)

### Handle TDR session output

```typescript
export function formatTDRSession(session: TDRSession): string {
  const sections = [
    `## TDR Session: ${session.id}`,
    `- Source: ${session.sourceFile}`,
    `- Status: ${session.status}`,
    `- Created: ${session.createdAt}`,
    `- Findings: ${session.originalFindings.length}`,
  ];

  if (session.verificationResult) {
    const vr = session.verificationResult;
    sections.push(`- Fixed: ${vr.fixed}`);
    sections.push(`- Resolved: ${vr.resolvedFindings.length}`);
    sections.push(`- Remaining: ${vr.remainingFindings.length}`);
    sections.push(`- New: ${vr.newFindings.length}`);
  }

  return sections.join("\n");
}
```

---

## 8. Acceptance Criteria

Phase 2C is complete when:

1. **TDR session creation works:** `start_tdr_session` returns a session ID with findings and generated tests.
2. **Fix verification works:** `verify_fix` returns whether the fix resolved the finding.
3. **Session status works:** `get_tdr_status` returns the current session state.
4. **CLI works end-to-end:** `code-verifier --start-tdr ./src/AuthScreen.tsx` creates a session.
5. **CLI verify-fix works:** `code-verifier --verify-fix --session-id ... ./src/AuthScreen.tsx` verifies the fix.
6. **MCP tools work:** All 3 new tools return correct data.
7. **Sessions persist:** Sessions survive MCP server restarts (file-based).

---

## 9. Implementation Order

1. `src/tdr/session-manager.ts` — Session management
2. `src/tdr/fix-verifier.ts` — Fix verification
3. `src/mcp-server.ts` — Add 3 new tools
4. `src/cli.ts` — Add CLI flags
5. `src/formatter/llm-formatter.ts` — TDR formatting

---

## 10. Review Checklist

After implementation, verify:

- [ ] All new files compile with `tsc`
- [ ] `npm test` still passes (existing tests not broken)
- [ ] `start_tdr_session` creates a session with findings + tests
- [ ] `verify_fix` returns correct fixed/remaining/new findings
- [ ] `get_tdr_status` returns session state
- [ ] Sessions persist to `.verifier/sessions/`
- [ ] CLI `--start-tdr` creates a session
- [ ] CLI `--verify-fix` verifies the fix
- [ ] MCP tools return correct JSON
