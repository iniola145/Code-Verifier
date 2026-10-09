import * as fs from "fs";
import * as path from "path";
import { UIDriver, createPlaywrightDriver, createDetoxDriver } from "./driver";
import { observeUI } from "./observer";

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
  screenshotDir?: string;
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

export interface StartUITestSessionOptions {
  framework?: "playwright" | "detox";
  target: string;
  flows?: string[];
  driver?: UIDriver;
  observer?: (driver: UIDriver, context: any) => Promise<{ observation: string; bugs: UIBug[]; nextAction?: string }>;
  llmCaller?: (prompt: string) => Promise<string>;
}

// In-memory session registry
const activeSessions = new Map<string, UITestSession>();
const activeDrivers = new Map<string, UIDriver>();

/**
 * Start a new UI test session.
 */
export async function startUITestSession(
  options: StartUITestSessionOptions,
): Promise<UITestSession> {
  const framework = options.framework || "playwright";
  const sessionId = `ui-session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = new Date().toISOString();

  const session: UITestSession = {
    id: sessionId,
    framework,
    target: options.target,
    status: "running",
    steps: [],
    bugs: [],
    startedAt,
  };

  activeSessions.set(sessionId, session);

  // Initialize or adopt driver
  let driver: UIDriver;
  let driverOwnedLocally = false;

  if (options.driver) {
    driver = options.driver;
  } else {
    driverOwnedLocally = true;
    driver =
      framework === "detox"
        ? await createDetoxDriver()
        : await createPlaywrightDriver();
  }

  activeDrivers.set(sessionId, driver);

  const observerFn = options.observer || observeUI;
  const flowsToRun =
    options.flows && options.flows.length > 0
      ? options.flows
      : ["initial_view", "main_interaction"];

  let stepCounter = 1;

  try {
    for (const flow of flowsToRun) {
      if (session.status !== "running") break;

      // 1. Navigate to target screen or flow
      const navPath = flow === "initial_view" ? options.target : `${options.target}#${flow}`;
      await driver.navigate(navPath);

      const screenshot = await driver.screenshot();
      const currentLoc = await driver.getCurrentLocation();

      // Save screenshot to disk
      const screenshotDir = path.join(process.cwd(), ".verifier", "screenshots");
      if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
      }
      const screenshotPath = path.join(screenshotDir, `${sessionId}-step-${stepCounter}.png`);
      try {
        const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
        fs.writeFileSync(screenshotPath, Buffer.from(base64Data, "base64"));
        session.screenshotDir = screenshotDir;
      } catch {
        // Screenshot storage is best-effort
      }

      // 2. Observe UI state
      const observationResult = await observerFn(driver, {
        previousSteps: [...session.steps],
        currentFlow: flow,
        llmCaller: options.llmCaller,
        targetPath: options.target,
      });

      const step: UISTep = {
        id: stepCounter++,
        action: `navigate to ${flow} (${currentLoc})`,
        timestamp: Date.now(),
        screenshot,
        observation: observationResult.observation,
      };
      session.steps.push(step);

      // Collect bugs from observation
      if (observationResult.bugs && observationResult.bugs.length > 0) {
        for (const bug of observationResult.bugs) {
          if (!session.bugs.some((b) => b.id === bug.id || b.description === bug.description)) {
            session.bugs.push(bug);
          }
        }
      }

      // 3. Execute next action if suggested
      if (observationResult.nextAction && session.status === "running") {
        const nextActionStr = observationResult.nextAction;
        let actionDesc = nextActionStr;

        if (nextActionStr.startsWith("click ")) {
          const sel = nextActionStr.slice(6).trim();
          await driver.click(sel);
          actionDesc = `click ${sel}`;
        } else if (nextActionStr.startsWith("type ")) {
          const parts = nextActionStr.slice(5).split(" ");
          const sel = parts[0];
          const text = parts.slice(1).join(" ") || "test input";
          await driver.type(sel, text);
          actionDesc = `type "${text}" into ${sel}`;
        } else if (nextActionStr.startsWith("scroll ")) {
          const sel = nextActionStr.slice(7).trim();
          await driver.scrollTo(sel);
          actionDesc = `scroll to ${sel}`;
        }

        const actionScreenshot = await driver.screenshot();
        const actionStep: UISTep = {
          id: stepCounter++,
          action: actionDesc,
          timestamp: Date.now(),
          screenshot: actionScreenshot,
        };
        session.steps.push(actionStep);

        // Follow-up observation
        const followUp = await observerFn(driver, {
          previousSteps: [...session.steps],
          currentFlow: `${flow}_action`,
          llmCaller: options.llmCaller,
          targetPath: options.target,
        });

        actionStep.observation = followUp.observation;
        if (followUp.bugs && followUp.bugs.length > 0) {
          for (const bug of followUp.bugs) {
            if (!session.bugs.some((b) => b.id === bug.id || b.description === bug.description)) {
              session.bugs.push(bug);
            }
          }
        }
      }
    }

    session.status = "completed";
    session.completedAt = new Date().toISOString();
  } catch (err: any) {
    session.status = "failed";
    session.completedAt = new Date().toISOString();
  } finally {
    if (driverOwnedLocally) {
      try {
        await driver.close();
      } catch {}
      activeDrivers.delete(sessionId);
    }
  }

  return session;
}

/**
 * Stop a UI test session.
 */
export async function stopUITestSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  if (session.status === "running") {
    session.status = "completed";
    session.completedAt = new Date().toISOString();
  }

  const driver = activeDrivers.get(sessionId);
  if (driver) {
    try {
      await driver.close();
    } catch {}
    activeDrivers.delete(sessionId);
  }
}

/**
 * Get the status of a UI test session.
 */
export function getUITestSession(sessionId: string): UITestSession | null {
  return activeSessions.get(sessionId) || null;
}

/**
 * List all active/completed UI test sessions.
 */
export function listUITestSessions(): UITestSession[] {
  return Array.from(activeSessions.values());
}

/**
 * Clear all UI test sessions (for test isolation).
 */
export function clearUITestSessions(): void {
  activeSessions.clear();
  activeDrivers.clear();
}
