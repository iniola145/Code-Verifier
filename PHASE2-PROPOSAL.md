# Code Verifier Phase 2: Test Generation + Runtime Verification

## Executive Summary

Code Verifier today is a strong **static analysis** engine (127 rules, abstract interpretation, taint tracking, MCP + CLI surfaces). It reasons about what *could* happen without running code. Phase 2 adds **test generation** and **runtime verification** — the ability to automatically generate test suites from static findings and confirm bugs through the user's existing test infrastructure.

This document incorporates architectural review feedback and proposes a revised, ROI-maximizing implementation plan.

---

## Part 1: Current State Assessment

### What exists today

| Layer | What it does | Key files |
|-------|-------------|-----------|
| **Parser** | Babel AST + TypeScript/JSX plugins | `src/parser/ast.ts` |
| **CFG Builder** | Per-function control flow graphs with edge conditions | `src/cfg/builder.ts` |
| **Abstract Interpreter** | Fixed-point solver with widening, path-sensitive refinement | `src/abstract-interpreter/fixpoint.ts` |
| **Domains** | Nullability (6-valued lattice), Interval, Taint | `src/abstract-interpreter/domain.ts` |
| **Function Summaries** | Cross-file return-value and taint-sink summarization | `src/abstract-interpreter/function-summaries.ts` |
| **Project Summaries** | Cross-file propagation through imports/barrels/aliases | `src/abstract-interpreter/project-summaries.ts` |
| **Rule Engine** | 127 rules, sequential execution, crash-proofed | `src/engine.ts`, `src/rules/` |
| **Config Scanners** | Mobile config, deployment config, native consistency | `src/mobile-config.ts`, `src/deployment-config.ts`, `src/native-consistency.ts` |
| **Project Checks** | tsc, eslint, build, test, audit, expo-doctor | `src/project-checks.ts` |
| **UI/Contract Index** | Component prop contracts, form schemas, style objects, CSS classes | `src/project-ui-index.ts` |
| **Formatters** | LLM markdown, SARIF 2.1.0, JSON, report | `src/formatter/` |
| **CLI** | Full arg parsing, config, baseline, concurrency | `src/cli.ts` |
| **MCP Server** | Single `verify_code` tool over stdio JSON-RPC | `src/mcp-server.ts` |
| **Test Suite** | ~200 assertions, custom runner, 95% precision/recall benchmark | `test/run-tests.ts`, `test/benchmark.ts` |

### What's missing

1. **No test generation** — can't create test suites from analysis
2. **No runtime verification** — can't confirm static findings are real bugs
3. **No test runner integration** — doesn't hook into Jest/Vitest/Playwright
4. **No selective instrumentation** — can't inject probes at flagged locations

### Extension points (where new code plugs in)

| Extension point | How to use it |
|-----------------|---------------|
| New AST rule | Add `VerificationRule` to `react-native-rules.ts`, add metadata to `registry.ts` |
| New config-file rule | Add stub + implement in `verify*.ts` module |
| New abstract domain | Extend `domain.ts`, wire into `MemoryState` |
| New formatter | Add file in `src/formatter/` |
| New MCP tool | Extend `mcp-server.ts` tool list |
| New CLI flag | Extend `cli.ts` arg parsing |
| New test generator | Add strategy in `src/test-gen/strategies.ts` |

---

## Part 2: Architectural Principles

### Core insight

**Don't replace the static engine. Extend it with test generation and runtime feedback.**

The static engine is good at finding *suspected* bugs. Test generation turns those suspicions into executable tests. Runtime feedback (from the user's existing test runner) confirms which findings are real.

### Key architectural decisions

1. **Test generation comes first** — it delivers immediate value with zero runtime dependencies
2. **Hook into existing test runners** — don't build a custom VM; use Jest/Vitest/Playwright reporters and setup files
3. **Selective instrumentation only** — instrument only the specific functions/lines that static analysis flagged, not everything
4. **Keep MCP server lean** — file-oriented and test-command execution, not stateful daemons
5. **Leverage existing contract indices** — `ProjectUiIndex` already has component contracts, form schemas, and style objects

### What we are NOT building

| Not building | Why |
|--------------|-----|
| Custom APM / dynamic analysis runtime | Overkill; the JS engine already throws native errors |
| Custom code execution VM | Can't run React Native in Node.js; use the user's existing test runner |
| Stateful MCP session daemon | Stdio MCP servers are killed/restarted frequently; use file-based trace exchange |
| Full-codebase instrumentation | Too invasive; only instrument flagged locations |

---

## Part 3: Test Generation

### The core value proposition

You can generate runnable tests **today** from the existing static engine — no runtime data needed. The 127 rules + `ProjectUiIndex` contracts + CFG invariants provide everything required to synthesize meaningful test cases.

### What you can generate (from existing infrastructure)

#### 1. Unit tests from static analysis findings

For each static finding, generate a test that would catch the bug:

```typescript
// Static finding: AI-NULL-001 — "user" could be null at line 42
// Generated test:
describe('getUser', () => {
  it('should handle null user', () => {
    const result = getUser(null);
    expect(result).toBeDefined();
  });
});
```

**Feasibility: HIGH** — You already have the AST, the rule context, and the code snippets. You know the function signature, the file path, and the suspected bug.

#### 2. Component tests from contract facts

`ProjectUiIndex` already extracts `ComponentContractFact` (required vs optional props, callback return types, nullability). Generate tests that verify components handle their contracts:

```typescript
// Component contract: UserCard requires title: string, user: User, onSave: () => void
// Generated test:
describe('UserCard', () => {
  it('renders with required props', () => {
    const props = { title: 'Test', user: mockUser, onSave: jest.fn() };
    render(<UserCard {...props} />);
    expect(screen.getByText('Test')).toBeTruthy();
  });

  it('calls onSave when save button pressed', () => {
    const onSave = jest.fn();
    render(<UserCard title="Test" user={mockUser} onSave={onSave} />);
    fireEvent.press(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalled();
  });

  it('handles optional subtitle prop', () => {
    render(<UserCard title="Test" user={mockUser} onSave={jest.fn()} subtitle="Sub" />);
    expect(screen.getByText('Sub')).toBeTruthy();
  });
});
```

**Feasibility: HIGH** — The contract extraction already works. You're rendering it as tests.

#### 3. Taint flow tests

Your taint tracking already identifies source→sink flows. Generate tests that exercise those flows:

```typescript
// Taint flow: deepLink param → AsyncStorage.setItem
// Generated test:
describe('AuthScreen', () => {
  it('should not store untrusted deep link tokens', async () => {
    const maliciousLink = 'myapp://auth?token=stale_token';
    Linking.emit('url', { url: maliciousLink });
    await waitFor(() => {
      expect(AsyncStorage.getItem('auth_token')).toBeNull();
    });
  });
});
```

**Feasibility: MEDIUM** — You know the flow, but generating the exact setup code (mocking Linking, AsyncStorage) requires framework-specific knowledge.

#### 4. Nullability invariant tests

Your abstract interpreter proves nullability lattices. Generate tests that exercise the null/undefined paths:

```typescript
// CFG invariant: "user" is Nullable at line 42 (proven by NullabilityDomain)
// Generated test:
describe('UserProfile', () => {
  it('should render loading state when user is null', () => {
    render(<UserProfile user={null} />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('should render error state when user is undefined', () => {
    render(<UserProfile user={undefined} />);
    expect(screen.getByText('Error')).toBeTruthy();
  });
});
```

**Feasibility: HIGH** — The nullability domain already tracks this. You're rendering it as tests.

#### 5. Race condition tests

Your race condition rules (RACE-001 through RACE-010) identify potential race conditions. Generate tests that exercise concurrent operations:

```typescript
// Race condition: RACE-003 — two async operations may complete out of order
// Generated test:
describe('DataFetcher', () => {
  it('should handle out-of-order responses', async () => {
    // First call resolves slower than second
    jest.spyOn(api, 'fetchUser')
      .mockOnce(() => new Promise(r => setTimeout(() => r(userA), 100)))
      .mockOnce(() => new Promise(r => setTimeout(() => r(userB), 10)));

    const promise1 = fetchUser('1');
    const promise2 = fetchUser('2');
    const [result1, result2] = await Promise.all([promise1, promise2]);

    // Should not have stale data
    expect(result1.id).toBe('1');
    expect(result2.id).toBe('2');
  });
});
```

**Feasibility: MEDIUM** — You know the race condition exists, but generating the exact timing setup is framework-specific.

#### 6. Mock Synthesis (critical for runnable tests)

Generated tests will crash at `import` time if external dependencies aren't mocked. The test generator must inspect the target file's `ImportDeclaration` nodes and automatically synthesize mocks for known packages.

**Strategy:**
1. Parse the target file's imports using the existing Babel AST
2. For each import, determine if it needs mocking:
   - **Well-known packages** (`@react-navigation/*`, `expo-router`, `AsyncStorage`, `react-native-webview`, etc.) → auto-generate `jest.mock()` or `vi.mock()` calls
   - **Relative service imports** (`./api`, `./services/auth`) → auto-generate `jest.spyOn()` or `jest.fn()` stubs
   - **React/React Native core** → use `@testing-library/react-native` (already mocked by default)
3. For unknown imports, generate a placeholder mock with a comment: `// TODO: mock this dependency`

**Example:**

```typescript
// Target file: AuthScreen.tsx imports:
//   import { useNavigation } from '@react-navigation/native';
//   import { login } from './api';
//   import AsyncStorage from '@react-native-async-storage/async-storage';

// Generated test file:
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useRoute: () => ({ params: {} }),
}));

jest.mock('./api', () => ({
  login: jest.fn(),
  fetchUser: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
  },
}));

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { AuthScreen } from './AuthScreen';
```

**Feasibility: HIGH** — You already have the AST and import information. The mock templates for well-known packages are standardized. This is the make-or-break feature: without it, every generated test fails at import time for the wrong reason.

**Auto-framework detection:** In `src/test-gen/generator.ts`, automatically inspect the target project's `package.json`:
- If `vitest` is in `devDependencies` → default to `src/test-gen/frameworks/vitest.ts` (`vi.mock`, `vi.fn`)
- If `jest`, `react-native`, or `expo` is present → default to `src/test-gen/frameworks/jest.ts` (`jest.mock`, `jest.fn`)
- Allow `--framework` flag to override

**Test file sandboxing:** Two output modes:
- `--output <dir>` (e.g. `./tests/generated/` or `.verifier/tests/`): Generates isolated test files that don't pollute the user's source tree or commit history during intermediate agent iterations.
- `--in-place`: Writes tests next to source files (e.g. `AuthScreen.test.tsx`) when the user or agent wants permanent regression test integration.

### Test generation architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Test Generator                             │
│                                                              │
│  Inputs:                                                     │
│  - Static findings (Diagnostic[])                           │
│  - Component contracts (ProjectUiIndex)                     │
│  - Taint flows (TaintDomain)                                │
│  - Nullability invariants (NullabilityDomain)               │
│  - Race conditions (RACE-* findings)                        │
│  - Function summaries (FunctionSummary[])                   │
│                                                              │
│  Strategies:                                                 │
│  1. Null/undefined → "handle null" test                     │
│  2. Taint flow → "untrusted input" test                     │
│  3. Component contract → "renders with props" test          │
│  4. Race condition → "concurrent operations" test           │
│  5. Async pattern → "handles rejection" test                │
│                                                              │
│  Outputs:                                                    │
│  - Test file content (string)                               │
│  - Test metadata (what it covers, confidence)               │
│  - Framework-specific formatting (Jest/Vitest/Detox)        │
└─────────────────────────────────────────────────────────────┘
```

### Test generation output format

```typescript
// Generated test file: src/screens/AuthScreen.test.tsx
// Generated by Code Verifier on 2026-10-09
// Covers: AI-NULL-001, RN-SEC-001, AI-TAINT-001

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { AuthScreen } from './AuthScreen';

// --- Static finding: AI-NULL-001 ---
// "user" could be null at line 42
describe('AuthScreen', () => {
  it('should handle null user from fetchUser', () => {
    jest.spyOn(api, 'fetchUser').mockResolvedValue(null);
    render(<AuthScreen />);
    expect(screen.getByText('User not found')).toBeTruthy();
  });
});

// --- Static finding: RN-SEC-001 ---
// Sensitive data in unencrypted AsyncStorage
describe('AuthScreen security', () => {
  it('should not store auth token in plain AsyncStorage', async () => {
    render(<AuthScreen />);
    await waitFor(() => {
      const token = await AsyncStorage.getItem('auth_token');
      expect(token).toBeNull();
    });
  });
});

// --- Taint flow: deepLink → AsyncStorage ---
describe('AuthScreen deep link handling', () => {
  it('should not persist untrusted deep link tokens', async () => {
    const maliciousLink = 'myapp://auth?token=stale_token';
    Linking.emit('url', { url: maliciousLink });
    await waitFor(() => {
      expect(AsyncStorage.getItem('auth_token')).toBeNull();
    });
  });
});
```

### Framework-specific generators

| Framework | Target | Generator approach |
|-----------|--------|-------------------|
| **Jest + React Native** | Unit/component tests | `@testing-library/react-native` + jest mocks |
| **Vitest** | Unit/component tests | `@testing-library/react-native` + vi mocks |
| **Detox** | E2E tests | Detox API + device automation |
| **Playwright** | Web E2E tests | Playwright API + browser automation |
| **Node.js (backend)** | API tests | Supertest + jest/vitest |

---

## Part 4: Runtime Verification

### The core insight

Static analysis finds *potential* bugs. Runtime verification confirms which ones are real. But instead of building a custom runtime, **hook into the test runner the user already has**.

### Approach: Test Runner Plugin

Instead of building a custom Babel instrumentation + trace collection VM, provide plugins for the test runners users already use:

#### Jest Reporter (`@code-verifier/jest-reporter`)

```typescript
// jest-reporter.ts
class CodeVerifierReporter {
  onTestResult(test, testResult) {
    // Capture failed assertions
    // Capture console errors
    // Capture unhandled rejections
    // Correlate with static findings
  }

  onRunComplete(contexts, results) {
    // Merge runtime results with static analysis
    // Produce unified report
  }
}
```

#### Vitest Plugin (`@code-verifier/vitest-plugin`)

```typescript
// vitest-plugin.ts
export default function codeVerifierPlugin() {
  return {
    name: 'code-verifier',
    enforce: 'post',
    async handleHotUpdate() { /* ... */ },
    async configureServer(server) { /* ... */ },
  };
}
```

#### Setup File (`@code-verifier/jest-setup`)

```typescript
// jest-setup.ts
// Captures runtime errors and correlates with static findings
const originalError = console.error;
console.error = (...args) => {
  __cv_capture_error(args);
  originalError.apply(console, args);
};

process.on('unhandledRejection', (reason) => {
  __cv_capture_rejection(reason);
});
```

### What runtime verification catches

| What | How | Value |
|------|-----|-------|
| **Confirmed null derefs** | Test fails with `TypeError: Cannot read property 'name' of null` | Turns `AI-NULL-001` from MEDIUM confidence to HIGH confidence |
| **Unhandled rejections** | `unhandledRejection` event fires | Confirms `TYPE-001` findings are real |
| **Race conditions** | Tests with concurrent operations fail intermittently | Confirms `RACE-*` findings |
| **API contract violations** | Tests with mocked API responses fail | Confirms `SERVICE-*` findings |
| **Component contract violations** | Tests with missing props fail | Confirms `COMP-*` findings |

### Selective instrumentation (only when needed)

For findings that need runtime confirmation but aren't covered by existing tests, inject probes **only at the flagged locations**:

```typescript
// Only instrument functions flagged by static analysis
// Input:
function getUser(id: string) {
  const user = fetchUser(id);  // ← AI-NULL-001 flagged here
  return user.name;
}

// Selectively instrumented output:
function getUser(id: string) {
  __cv_enter("getUser", { id });
  const user = fetchUser(id);
  if (user === null || user === undefined) {
    __cv_report("AI-NULL-001", { location: "L3", value: user });
  }
  __cv_exit("getUser", user?.name);
  return user.name;
}
```

**Key principle:** Only instrument what static analysis flagged. Don't instrument the entire codebase.

### Trace format

```jsonl
{"type":"function_enter","name":"getUser","args":["123"],"ts":1696100000}
{"type":"null_check","var":"user","value":null,"location":"L3","ruleId":"AI-NULL-001","ts":1696100001}
{"type":"function_exit","name":"getUser","returnValue":undefined,"ts":1696100002}
{"type":"promise_rejected","reason":"TypeError: Cannot read property 'name' of null","ts":1696100003}
```

### Runtime rules

| Rule | What it confirms | How |
|------|-----------------|-----|
| `RT-CONFIRM-001` | Static finding is real | Test fails at the exact location static analysis flagged |
| `RT-CONFIRM-002` | Null dereference happened | Trace shows null value at dereference point |
| `RT-CONFIRM-003` | Unhandled rejection occurred | Trace shows rejection with no catch handler |
| `RT-CONFIRM-004` | Race condition manifested | Trace shows out-of-order async completion |
| `RT-NEW-001` | New bug not found statically | Runtime error with no corresponding static finding |

---

## Part 5: MCP + CLI Integration

### MCP Server Extension

The current MCP server is stateless stdio. New tools should be **file-oriented and stateless** — no stateful sessions.

```typescript
// tools/list returns:
{
  name: "verify_code",
  description: "Static analysis of code (existing)"
},
{
  name: "generate_tests",
  description: "Generate test suite from static analysis. Returns test file content."
},
{
  name: "verify_fix",
  description: "Run verification on modified code and check if findings are resolved."
},
{
  name: "get_runtime_findings",
  description: "Get runtime findings from a trace file. Returns confirmed bugs with evidence."
},
{
  name: "correlate_finding",
  description: "Map a runtime finding back to source code location and static analysis result."
}
```

**Key design principle:** Each MCP tool is stateless. `generate_tests` takes a file path and returns test content. `get_runtime_findings` takes a trace file path and returns findings. No sessions, no daemons.

### The TDR (Test-Driven Remediation) Agent Loop

The greatest commercial and practical value of Phase 2 is enabling **autonomous self-healing for LLM coding agents**. This loop should be explicit in the MCP surface design:

1. **Agent Step 1:** Call `verify_code` → receives finding `AI-NULL-001` or `COMP-001`.
2. **Agent Step 2:** Call `generate_tests` → receives a minimal, reproducible test case.
3. **Agent Step 3:** Agent runs the test (or calls the test runner) → **Test fails (Red)**, proving the bug is real.
4. **Agent Step 4:** Agent modifies the source code to fix the issue.
5. **Agent Step 5:** Call `verify_fix` → static engine confirms the finding is cleared AND the generated test passes **(Green)**.

This gives AI agents (Cursor, Claude, Gemini, Antigravity) the ability to verify their own fixes with mathematical and empirical certainty. The loop is:

```
┌─────────────────────────────────────────────────┐
│              TDR Agent Loop                      │
│                                                  │
│  verify_code → generate_tests → run test         │
│       ↑                            │             │
│       │                      test fails (Red)    │
│       │                            │             │
│       │                    agent fixes code       │
│       │                            │             │
│  verify_fix ←──────────────────────┘             │
│  (test passes = Green)                           │
│                                                  │
└─────────────────────────────────────────────────┘
```

### CLI Extension

```bash
# Generate tests from static analysis
code-verifier --generate-tests ./src/ --output ./tests/

# Generate tests for a specific rule
code-verifier --generate-tests ./src/ --rule AI-NULL-001

# Run with test runner integration
code-verifier --with-jest --jest-config jest.config.js

# Analyze runtime traces
code-verifier --runtime-traces trace.jsonl --correlate

# Verify a fix
code-verifier --verify-fix --baseline baseline.json ./src/

# Selective instrumentation (only flagged locations)
code-verifier --instrument ./src/ --output ./instrumented/
```

### Formatter Extension

The existing formatters already support multiple diagnostic sources. Runtime findings flow through the same pipeline:

```
Static diagnostics ──┐
                     ├──> Diagnostic[] ──> Formatter (LLM/SARIF/JSON) ──> CLI/MCP
Runtime diagnostics ─┘
```

Each runtime diagnostic includes:
- `source: "runtime"` (vs `"static"`)
- `trace: TraceEvent[]` (the evidence)
- `confidence: "HIGH"` (runtime findings are confirmed, not suspected)
- `confirmedBy: string` (the test that confirmed it)

---

## Part 6: Phased Implementation Plan

### Phase 2A: Test Generation from Static Facts (Weeks 1-3)

**Goal:** Generate runnable tests from the existing static engine — no runtime dependencies.

**New files:**
- `src/test-gen/generator.ts` — Test generation orchestrator
- `src/test-gen/strategies.ts` — Test generation strategies (null, taint, contract, race, async)
- `src/test-gen/templates.ts` — Test file templates
- `src/test-gen/frameworks/jest.ts` — Jest-specific generator
- `src/test-gen/frameworks/vitest.ts` — Vitest-specific generator
- `src/test-gen/frameworks/detox.ts` — Detox-specific generator

**Approach:**
1. For each static finding, determine the appropriate test strategy
2. Generate test code using templates
3. For component contracts, generate render + interaction tests
4. For taint flows, generate input → sink tests
5. For nullability invariants, generate null/undefined tests
6. Output test files with metadata about what they cover

**Deliverable:** `code-verifier --generate-tests ./src/ --output ./tests/` produces runnable test files.

### Phase 2B: Test Runner Integration (Weeks 4-5)

**Goal:** Hook into the user's existing test runner to capture runtime data.

**New files:**
- `src/adapters/jest-reporter.ts` — Jest reporter (compiled to `dist/adapters/jest-reporter.js`)
- `src/adapters/vitest-plugin.ts` — Vitest plugin (compiled to `dist/adapters/vitest-plugin.js`)
- `src/adapters/jest-setup.ts` — Jest setup file (compiled to `dist/adapters/jest-setup.js`)
- `src/runtime/trace-parser.ts` — Parse trace files
- `src/runtime/runtime-engine.ts` — Runtime rule runner

**Package exports (no monorepo):**
Keep the project as a single package. Expose adapters via `exports` subpaths in `package.json`:

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

Users configure:
```js
// jest.config.js
reporters: ['default', 'code-verifier/jest-reporter']
```

**Approach:**
1. Build Jest reporter that captures failed assertions, console errors, and unhandled rejections
2. Build Vitest plugin that does the same
3. Build setup file that captures runtime errors
4. Parse trace files and correlate with static findings
5. Produce unified report with confirmed findings

**Deliverable:** `code-verifier --with-jest --jest-config jest.config.js` runs tests and produces unified static + runtime report.

### Phase 2C: MCP Test-and-Fix Loop (Weeks 6-7)

**Goal:** Expose test generation and verification to LLM agents.

**Modified files:**
- `src/mcp-server.ts` — Add `generate_tests`, `verify_fix`, `get_runtime_findings`, `correlate_finding` tools
- `src/cli.ts` — Add `--generate-tests`, `--verify-fix`, `--runtime-traces` flags
- `src/formatter/llm-formatter.ts` — Handle runtime diagnostics

**Approach:**
1. Add `generate_tests` MCP tool — takes file path, returns test content
2. Add `verify_fix` MCP tool — runs verification, checks if findings resolved
3. Add `get_runtime_findings` MCP tool — takes trace file, returns findings
4. Add `correlate_finding` MCP tool — maps runtime finding to source
5. Update CLI with new flags
6. Update formatters to handle runtime diagnostics

**Deliverable:** LLM agents can generate tests, run them, and verify fixes via MCP.

### Phase 2D: Selective Instrumentation (Weeks 8-10)

**Goal:** Inject probes at flagged locations for findings that need runtime confirmation.

**New files:**
- `src/runtime/instrument.ts` — Selective Babel instrumentation plugin
- `src/runtime/trace-collector.ts` — Runtime trace collection
- `src/runtime/types.ts` — Runtime-specific types

**Approach:**
1. Write a Babel plugin that only instruments functions flagged by static analysis
2. Inject `__cv_enter`, `__cv_exit`, `__cv_check_null` at flagged locations only
3. The trace collector buffers events and flushes to a file
4. Make all probes no-op when `__cv_disabled` is set (for production)
5. Manage sourcemaps to preserve line numbers

**Deliverable:** `code-verifier --instrument ./src/ --output ./instrumented/` produces instrumented code with probes only at flagged locations.

### Phase 2E: LLM-Driven UI Testing (Optional, Weeks 11-12)

**Goal:** Use LLM agents to drive the app and find bugs a human would find.

**Approach:**
1. Use Playwright or Detox to drive the app
2. The MCP server exposes a `start_ui_session` tool that returns a browser/device handle
3. An LLM agent interacts with the UI, observes behavior, and reports bugs
4. Bugs are correlated back to source code

**This is the most powerful but most expensive approach.** It catches visual bugs, UX bugs, and "works but feels wrong" bugs.

---

## Part 7: What This Unlocks

### For individual developers
- **"Generate tests for my existing code"** — Point Code Verifier at your codebase, get a test suite
- **"Confirm which findings are real"** — Run generated tests, see which static findings actually manifest
- **"Catch regressions"** — Run the generated tests in CI

### For teams
- **"Onboard faster"** — New team members get generated tests that document expected behavior
- **"Refactor with confidence"** — Generated tests catch what static analysis misses
- **"Security audits"** — Taint flow + generated tests = proof that vulnerabilities are exploitable

### For LLM agents
- **"Verify your changes work"** — After making a change, run verification to confirm it works
- **"Find edge cases"** — Generate tests that cover edge cases the agent might have missed
- **"Self-heal"** — Find a bug → fix it → verify the fix with generated tests

---

## Part 8: Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Test generation produces broken tests | Medium | Generate compile-checkable tests; run them and report failures |
| Test runner integration is framework-specific | Medium | Start with Jest (most common), expand to Vitest/Detox later |
| Selective instrumentation misses edge cases | Low | Only instrument when static analysis has high confidence |
| Trace volume is too large | Low | Only instrument flagged locations; sample traces |
| MCP server becomes stateful | Medium | Keep all tools stateless; use file-based trace exchange |
| Generated tests have false positives | Medium | Run tests and report failures; let users filter |

---

## Part 9: Recommended First Steps

1. **Build the test generator for static findings** (Phase 2A) — This is the foundation. It delivers immediate value with zero runtime dependencies.
2. **Build the Jest reporter** (Phase 2B) — This captures runtime data from the user's existing test runner.
3. **Integrate with MCP** (Phase 2C) — Expose test generation and verification to LLM agents.
4. **Add selective instrumentation** (Phase 2D) — Only for findings that need runtime confirmation.
5. **Explore LLM-driven UI testing** (Phase 2E) — The holy grail, but optional.

---

## Appendix: File Inventory (Current)

### Source files (21 files)
```
src/action.ts
src/baseline.ts
src/cli.ts
src/config.ts
src/deployment-config.ts
src/engine.ts
src/index.ts
src/mobile-config.ts
src/mcp-server.ts
src/native-consistency.ts
src/project-checks.ts
src/project-ui-index.ts
src/scan-cache.ts
src/semantic-analysis.ts
src/unused-files.ts
src/abstract-interpreter/domain.ts
src/abstract-interpreter/fixpoint.ts
src/abstract-interpreter/function-summaries.ts
src/abstract-interpreter/project-summaries.ts
src/abstract-interpreter/refine.ts
src/abstract-interpreter/symbols.ts
src/abstract-interpreter/ts-types.ts
src/cfg/builder.ts
src/formatter/llm-formatter.ts
src/formatter/report.ts
src/formatter/sarif.ts
src/parser/ast.ts
src/rules/application-security-rules.ts
src/rules/backend-rules.ts
src/rules/component-contract-rules.ts
src/rules/correctness-rules.ts
src/rules/cwe-security-rules.ts
src/rules/deployment-rules.ts
src/rules/expo-router-rules.ts
src/rules/form-style-rules.ts
src/rules/framework-security-rules.ts
src/rules/hygiene-rules.ts
src/rules/logic-analysis-rules.ts
src/rules/mobile-config-rules.ts
src/rules/native-consistency-rules.ts
src/rules/race-condition-rules.ts
src/rules/react-correctness-rules.ts
src/rules/react-native-rules.ts
src/rules/react19-rules.ts
src/rules/registry.ts
src/rules/reliability-rules.ts
src/rules/semantic-rules.ts
src/rules/server-state-rules.ts
src/types/verifier.ts
```

### Test files
```
test/run-tests.ts       (3,677 lines, ~200 assertions)
test/benchmark.ts      (17 vulnerable/fixed pairs)
test/fixtures/project-summaries/  (9 fixture files + tsconfig)
test/fixtures/ui-project/         (16 fixture files)
```

### Samples
```
samples/VulnerableScreen.tsx
samples/ambient.d.ts
```

---

## Appendix: New Files to Create

### Phase 2A (Test Generation)
```
src/test-gen/generator.ts
src/test-gen/strategies.ts
src/test-gen/templates.ts
src/test-gen/frameworks/jest.ts
src/test-gen/frameworks/vitest.ts
src/test-gen/frameworks/detox.ts
```

### Phase 2B (Test Runner Integration)
```
src/adapters/jest-reporter.ts
src/adapters/vitest-plugin.ts
src/adapters/jest-setup.ts
src/runtime/trace-parser.ts
src/runtime/runtime-engine.ts
```

### Phase 2C (MCP Integration)
```
src/mcp-server.ts (modified)
src/cli.ts (modified)
src/formatter/llm-formatter.ts (modified)
```

### Phase 2D (Selective Instrumentation)
```
src/runtime/instrument.ts
src/runtime/trace-collector.ts
src/runtime/types.ts
```
