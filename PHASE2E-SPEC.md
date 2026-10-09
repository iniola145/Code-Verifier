# Phase 2E Specification: LLM-Driven UI Testing

## Overview

This document is a self-contained specification for implementing Phase 2E of Code Verifier. The implementer should be able to execute this plan without additional context.

**Goal:** Use LLM agents to drive the app via Playwright/Detox and find bugs a human would find — visual bugs, UX bugs, and "works but feels wrong" bugs.

**Deliverable:** `code-verifier --ui-test ./src/` starts a UI session, drives the app, and reports bugs.

---

## 1. The Problem

Static analysis finds *potential* bugs. Runtime verification confirms *suspected* bugs. But some bugs are only visible to a human (or LLM) looking at the app:

- Visual bugs (layout, styling, animation)
- UX bugs (confusing flows, dead ends, broken interactions)
- "Works but feels wrong" bugs (slow, janky, inconsistent)
- Integration bugs (features that work individually but break together)

Phase 2E solves this by using an LLM agent to:
1. Drive the app via Playwright (web) or Detox (React Native)
2. Observe the UI and interactions
3. Report bugs that only manifest visually or behaviorally

---

## 2. File Structure

### New files to create

```
src/ui-test/
  session.ts            — UI test session manager
  driver.ts             — Playwright/Detox driver abstraction
  observer.ts           — LLM-powered UI observer
  reporter.ts           — Bug report generator
```

### Files to modify

```
src/cli.ts              — Add --ui-test flag
src/mcp-server.ts       — Add start_ui_session, stop_ui_session tools
```

---

## 3. UI Test Session (`src/ui-test/session.ts`)

### Purpose

Manages a UI test session. The session:
1. Starts the app (web or React Native)
2. Drives the app through critical user flows
3. Observes the UI at each step
4. Reports bugs found

### API

```typescript
/**
 * A UI test session.
 */
export interface UITestSession {
  id: string;
  framework: "playwright" | "detox";
  target: string;
  status: "running" | "completed" | "failed";
  steps: UISTep[];
  bugs: UIBug[];
  startedAt: string;
  completedAt?: string;
}

/**
 * A single UI test step.
 */
export interface UISTep {
  id: number;
  action: string;
  selector?: string;
  timestamp: number;
  screenshot?: string;
  observation?: string;
}

/**
 * A bug found during UI testing.
 */
export interface UIBug {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: "visual" | "ux" | "functional" | "performance";
  description: string;
  location?: string;
  screenshot?: string;
  reproductionSteps: string[];
}

/**
 * Start a new UI test session.
 */
export async function startUITestSession(options: {
  framework: "playwright" | "detox";
  target: string;
  flows?: string[];
}): Promise<UITestSession>;

/**
 * Stop a UI test session.
 */
export async function stopUITestSession(sessionId: string): Promise<void>;

/**
 * Get the status of a UI test session.
 */
export function getUITestSession(sessionId: string): UITestSession | null;
```

---

## 4. Driver Abstraction (`src/ui-test/driver.ts`)

### Purpose

Abstracts Playwright and Detox behind a common interface.

### API

```typescript
/**
 * A UI driver that can interact with the app.
 */
export interface UIDriver {
  /** Navigate to a screen */
  navigate(path: string): Promise<void>;
  
  /** Click an element */
  click(selector: string): Promise<void>;
  
  /** Type into an input */
  type(selector: string, text: string): Promise<void>;
  
  /** Take a screenshot */
  screenshot(): Promise<string>;
  
  /** Get the current URL or screen name */
  getCurrentLocation(): Promise<string>;
  
  /** Wait for an element to appear */
  waitFor(selector: string, timeout?: number): Promise<void>;
  
  /** Check if an element is visible */
  isVisible(selector: string): Promise<boolean>;
  
  /** Get the text content of an element */
  getText(selector: string): Promise<string>;
  
  /** Scroll to an element */
  scrollTo(selector: string): Promise<void>;
  
  /** Close the driver */
  close(): Promise<void>;
}

/**
 * Create a Playwright driver.
 */
export function createPlaywrightDriver(): Promise<UIDriver>;

/**
 * Create a Detox driver.
 */
export function createDetoxDriver(): Promise<UIDriver>;
```

---

## 5. LLM Observer (`src/ui-test/observer.ts`)

### Purpose

Uses an LLM to observe the UI and detect bugs.

### API

```typescript
/**
 * Observe the current UI state and detect bugs.
 */
export async function observeUI(
  driver: UIDriver,
  context: {
    previousSteps: UISTep[];
    currentFlow: string;
  },
): Promise<{
  observation: string;
  bugs: UIBug[];
  nextAction?: string;
}>;
```

### Implementation outline

```typescript
export async function observeUI(driver: UIDriver, context) {
  // 1. Take a screenshot
  const screenshot = await driver.screenshot();
  
  // 2. Get the current location
  const location = await driver.getCurrentLocation();
  
  // 3. Build a prompt for the LLM
  const prompt = buildObservationPrompt({
    screenshot,
    location,
    previousSteps: context.previousSteps,
    currentFlow: context.currentFlow,
  });
  
  // 4. Call the LLM
  const response = await callLLM(prompt);
  
  // 5. Parse the response
  return parseObservationResponse(response);
}

function buildObservationPrompt(context) {
  return `You are testing a React Native app. Observe the current UI state and identify any bugs.

Current screen: ${context.location}
Current flow: ${context.currentFlow}
Previous steps: ${context.previousSteps.map(s => s.action).join(", ")}

Look for:
- Visual bugs (layout issues, overlapping elements, wrong colors)
- UX bugs (confusing navigation, dead ends, broken interactions)
- Functional bugs (buttons that don't work, forms that don't submit)
- Performance issues (slow rendering, janky animations)

Screenshot: ${context.screenshot}

Respond with:
1. A brief observation of the current state
2. Any bugs found (with severity, category, description, and reproduction steps)
3. The next action to take (if any)`;
}
```

---

## 6. Bug Reporter (`src/ui-test/reporter.ts`)

### Purpose

Generates a bug report from a UI test session.

### API

```typescript
/**
 * Generate a bug report from a UI test session.
 */
export function generateBugReport(session: UITestSession): string;
```

### Output format

```markdown
# UI Test Report

**Session:** {session.id}
**Target:** {session.target}
**Duration:** {duration}
**Steps:** {session.steps.length}
**Bugs Found:** {session.bugs.length}

## Bugs

### 1. [HIGH] Visual: Button text is truncated
- **Location:** /src/components/SubmitButton.tsx
- **Severity:** High
- **Category:** Visual
- **Description:** The submit button text is truncated on small screens
- **Reproduction Steps:**
  1. Navigate to the login screen
  2. Observe the submit button
- **Screenshot:** [attached]

### 2. [MEDIUM] UX: No feedback after form submission
- **Location:** /src/screens/LoginScreen.tsx
- **Severity:** Medium
- **Category:** UX
- **Description:** After submitting the form, there is no loading indicator or success message
- **Reproduction Steps:**
  1. Navigate to the login screen
  2. Fill in the form
  3. Click submit
  4. Observe: no feedback for 3 seconds
- **Screenshot:** [attached]

## Summary

- Critical: 0
- High: 1
- Medium: 1
- Low: 0
```

---

## 7. CLI Integration (`src/cli.ts`)

### New flag

```bash
# Run UI tests with Playwright
code-verifier --ui-test ./src/ --framework=playwright

# Run UI tests with Detox
code-verifier --ui-test ./src/ --framework=detox

# Run UI tests with specific flows
code-verifier --ui-test ./src/ --flows="login,signup,dashboard"
```

### CLI implementation outline

```typescript
// In src/cli.ts, add to arg parsing:
const uiTest = args.includes("--ui-test");
const uiFramework = getFlag(args, "--framework") || "playwright";
const uiFlows = getFlag(args, "--flows");

if (uiTest) {
  const target = targets[0];
  if (!target) {
    console.error("Error: No target specified for --ui-test.");
    process.exit(1);
  }
  
  const session = await startUITestSession({
    framework: uiFramework as "playwright" | "detox",
    target,
    flows: uiFlows?.split(","),
  });
  
  console.log(`UI Test Session: ${session.id}`);
  console.log(`Status: ${session.status}`);
  console.log(`Steps: ${session.steps.length}`);
  console.log(`Bugs Found: ${session.bugs.length}`);
  
  const report = generateBugReport(session);
  console.log(report);
  
  process.exit(session.bugs.length > 0 ? 1 : 0);
}
```

---

## 8. MCP Integration (`src/mcp-server.ts`)

### New tools

```typescript
// tools/list returns:
{
  name: "start_ui_session",
  description: "Start a UI test session. Returns session ID and initial state.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Target app to test",
      },
      framework: {
        type: "string",
        enum: ["playwright", "detox"],
        description: "UI testing framework",
        default: "playwright",
      },
      flows: {
        type: "array",
        items: { type: "string" },
        description: "User flows to test",
      },
    },
    required: ["target"],
  },
},
{
  name: "stop_ui_session",
  description: "Stop a UI test session and return the bug report.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "UI test session ID",
      },
    },
    required: ["sessionId"],
  },
}
```

### Handlers

```typescript
if (toolName === "start_ui_session") {
  const { target, framework, flows } = args;
  
  const session = await startUITestSession({
    framework: framework as "playwright" | "detox",
    target,
    flows,
  });
  
  this.sendResponse(id, {
    content: [{
      type: "text",
      text: JSON.stringify({
        sessionId: session.id,
        status: session.status,
        steps: session.steps.length,
        bugs: session.bugs.length,
      }, null, 2),
    }],
    isError: false,
  });
  return;
}

if (toolName === "stop_ui_session") {
  const { sessionId } = args;
  
  await stopUITestSession(sessionId);
  const session = getUITestSession(sessionId);
  
  if (!session) {
    this.sendResponse(id, {
      content: [{ type: "text", text: "Session not found" }],
      isError: true,
    });
    return;
  }
  
  const report = generateBugReport(session);
  
  this.sendResponse(id, {
    content: [{ type: "text", text: report }],
    isError: session.bugs.length > 0,
  });
  return;
}
```

---

## 9. Acceptance Criteria

Phase 2E is complete when:

1. **Session creation works:** `start_ui_session` returns a session ID with initial state.
2. **Driver abstraction works:** Both Playwright and Detox drivers implement the `UIDriver` interface.
3. **LLM observer works:** `observeUI` returns observations and bugs.
4. **Bug reporter works:** `generateBugReport` returns a formatted markdown report.
5. **CLI works end-to-end:** `code-verifier --ui-test ./src/ --framework=playwright` runs UI tests.
6. **MCP tools work:** Both `start_ui_session` and `stop_ui_session` return correct data.
7. **Bugs are detected:** The system finds at least one real bug in a test app.

---

## 10. Implementation Order

1. `src/ui-test/session.ts` — Session management
2. `src/ui-test/driver.ts` — Driver abstraction (Playwright first, Detox second)
3. `src/ui-test/observer.ts` — LLM observer
4. `src/ui-test/reporter.ts` — Bug reporter
5. `src/cli.ts` — CLI integration
6. `src/mcp-server.ts` — MCP integration

---

## 11. Review Checklist

After implementation, verify:

- [ ] All new files compile with `tsc`
- [ ] `npm test` still passes (existing tests not broken)
- [ ] Session creation returns a valid session ID
- [ ] Playwright driver can navigate, click, type, screenshot
- [ ] LLM observer returns observations and bugs
- [ ] Bug reporter generates valid markdown
- [ ] CLI `--ui-test` flag works end-to-end
- [ ] MCP `start_ui_session` and `stop_ui_session` tools work
- [ ] At least one real bug is detected in a test app
