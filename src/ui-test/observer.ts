import * as fs from "fs";
import * as path from "path";
import { UIDriver } from "./driver";
import { UIBug, UISTep } from "./session";

export interface ObserveUIContext {
  previousSteps: UISTep[];
  currentFlow: string;
  customPrompt?: string;
  llmCaller?: (prompt: string) => Promise<string>;
  targetPath?: string;
}

export interface ObservationResult {
  observation: string;
  bugs: UIBug[];
  nextAction?: string;
}

/**
 * Builds the prompt for the LLM UI observer.
 */
export function buildObservationPrompt(context: {
  screenshot: string;
  location: string;
  previousSteps: UISTep[];
  currentFlow: string;
}): string {
  return `You are testing a React Native app. Observe the current UI state and identify any bugs.

Current screen: ${context.location}
Current flow: ${context.currentFlow}
Previous steps: ${context.previousSteps.map((s) => s.action).join(", ")}

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

/**
 * Parses the response from an LLM into structured observation, bugs, and nextAction.
 */
export function parseObservationResponse(responseText: string): ObservationResult {
  // 1. Try parsing JSON format
  try {
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, responseText];
    const candidate = jsonMatch[1] || responseText;
    const parsed = JSON.parse(candidate.trim());
    if (parsed && (parsed.observation || parsed.bugs)) {
      return {
        observation: parsed.observation || "Observed UI screen.",
        bugs: Array.isArray(parsed.bugs)
          ? parsed.bugs.map((b: any, i: number) => ({
              id: b.id || `ui-bug-${i + 1}`,
              severity: (b.severity || "medium").toLowerCase() as any,
              category: (b.category || "visual").toLowerCase() as any,
              description: b.description || b.message || "UI issue detected",
              location: b.location,
              screenshot: b.screenshot,
              reproductionSteps: Array.isArray(b.reproductionSteps)
                ? b.reproductionSteps
                : [b.description || "Reproduce by navigating to screen"],
            }))
          : [],
        nextAction: parsed.nextAction,
      };
    }
  } catch {}

  // 2. Parse structured markdown / text format
  let observation = "";
  const bugs: UIBug[] = [];
  let nextAction: string | undefined;

  const lines = responseText.split("\n");
  let currentSection = "";
  let bugIndex = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (/^1\.\s*observation|^observation:/i.test(line)) {
      currentSection = "observation";
      observation = line.replace(/^1\.\s*observation:?|^observation:?/i, "").trim();
      continue;
    }

    if (/^2\.\s*bugs|^bugs found:?|^## bugs/i.test(line)) {
      currentSection = "bugs";
      continue;
    }

    if (/^3\.\s*next action|^next action:/i.test(line)) {
      currentSection = "nextAction";
      nextAction = line.replace(/^3\.\s*next action:?|^next action:?/i, "").trim();
      continue;
    }

    if (currentSection === "observation" && !observation) {
      observation = line;
    } else if (currentSection === "observation") {
      observation += " " + line;
    } else if (currentSection === "bugs") {
      // Look for bug header: e.g. "- [HIGH] Visual: Button text truncated" or "### 1. [HIGH]"
      const bugHeader = line.match(/(?:[-*]|\d+\.)\s*\[(CRITICAL|HIGH|MEDIUM|LOW)\]\s*([^:]+)?:\s*(.+)/i);
      if (bugHeader) {
        const severity = bugHeader[1].toLowerCase() as any;
        const category = (bugHeader[2] || "visual").toLowerCase().trim() as any;
        const description = bugHeader[3].trim();
        bugs.push({
          id: `ui-bug-${bugIndex++}`,
          severity,
          category: ["visual", "ux", "functional", "performance"].includes(category)
            ? category
            : "visual",
          description,
          reproductionSteps: [`Navigate to current screen`, `Observe: ${description}`],
        });
      }
    } else if (currentSection === "nextAction" && !nextAction) {
      nextAction = line;
    }
  }

  if (!observation) {
    observation = responseText.slice(0, 150).trim() || "UI observed successfully.";
  }

  return {
    observation,
    bugs,
    nextAction,
  };
}

/**
 * Observe the current UI state and detect bugs using an LLM or intelligent heuristic fallback.
 */
export async function observeUI(
  driver: UIDriver,
  context: ObserveUIContext,
): Promise<ObservationResult> {
  const screenshot = await driver.screenshot();
  const location = await driver.getCurrentLocation();

  // If external LLM caller is supplied, query the LLM
  if (context.llmCaller) {
    const prompt = buildObservationPrompt({
      screenshot,
      location,
      previousSteps: context.previousSteps,
      currentFlow: context.currentFlow,
    });
    const response = await context.llmCaller(prompt);
    return parseObservationResponse(response);
  }

  // Built-in intelligent inspector for UI analysis
  const bugs: UIBug[] = [];
  let nextAction: string | undefined;

  // 1. Inspect target source code if available
  let sourceCode = "";
  if (context.targetPath) {
    const resolved = path.resolve(context.targetPath.split("#")[0]);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      try {
        sourceCode = fs.readFileSync(resolved, "utf-8");
      } catch {}
    }
  }

  // Check for common visual/UX bugs in target code or state
  if (sourceCode) {
    // Visual: truncated button text / fixed tiny width
    if (
      /style\s*=\s*\{\s*\{[^}]*width\s*:\s*(?:[1-4][0-9]|[1-9])\b[^}]*\}\s*\}/.test(sourceCode) &&
      /<(?:button|TouchableOpacity|Pressable|Text)[^>]*>[^<]{10,}/.test(sourceCode)
    ) {
      bugs.push({
        id: `ui-bug-${Date.now()}-1`,
        severity: "high",
        category: "visual",
        description: "Button text is truncated on small screens due to constrained width",
        location: context.targetPath,
        screenshot,
        reproductionSteps: [
          `Navigate to ${location}`,
          `Inspect button dimensions`,
          `Observe truncated text`,
        ],
      });
    }

    // UX: Form submit without loading indicator or feedback
    if (
      /<form|<Button[^>]*title=["']Submit["']|<TouchableOpacity[^>]*>[^<]*Submit/i.test(sourceCode) &&
      !/(?:isLoading|ActivityIndicator|disabled=\{loading\}|setLoading)/.test(sourceCode)
    ) {
      bugs.push({
        id: `ui-bug-${Date.now()}-2`,
        severity: "medium",
        category: "ux",
        description: "No feedback or loading indicator after form submission",
        location: context.targetPath,
        screenshot,
        reproductionSteps: [
          `Navigate to ${location}`,
          `Fill in form fields`,
          `Click submit`,
          `Observe: no loading feedback provided to user`,
        ],
      });
    }

    // Functional: Missing onPress or onClick on interactive elements
    if (
      /<(?:TouchableOpacity|Pressable|Button)\b(?![^>]*onPress)[^>]*>/i.test(sourceCode) ||
      /<button\b(?![^>]*onClick)[^>]*>/i.test(sourceCode)
    ) {
      bugs.push({
        id: `ui-bug-${Date.now()}-3`,
        severity: "high",
        category: "functional",
        description: "Interactive button lacks an event handler and cannot be triggered",
        location: context.targetPath,
        screenshot,
        reproductionSteps: [
          `Navigate to ${location}`,
          `Click on the interactive element`,
          `Observe: no action performed`,
        ],
      });
    }

    // Performance: Large list without virtualization
    if (
      /\.map\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*</.test(sourceCode) &&
      !/(?:FlatList|SectionList|VirtualizedList|FlashList)/.test(sourceCode) &&
      /(?:items|data|list|rows)\s*[=:]\s*\[/.test(sourceCode)
    ) {
      bugs.push({
        id: `ui-bug-${Date.now()}-4`,
        severity: "medium",
        category: "performance",
        description: "Large list rendered without virtualization may cause performance issues",
        location: context.targetPath,
        screenshot,
        reproductionSteps: [
          `Navigate to ${location}`,
          `Scroll through the list`,
          "Observe: janky scrolling or slow rendering",
        ],
      });
    }

    // Accessibility: Missing accessibilityLabel on interactive elements
    if (
      /<(?:TouchableOpacity|Pressable|Button)\b(?![^>]*accessibilityLabel)[^>]*>/i.test(sourceCode) &&
      /<(?:TouchableOpacity|Pressable|Button)\b[^>]*onPress/i.test(sourceCode)
    ) {
      bugs.push({
        id: `ui-bug-${Date.now()}-5`,
        severity: "low",
        category: "ux",
        description: "Interactive element missing accessibilityLabel for screen readers",
        location: context.targetPath,
        screenshot,
        reproductionSteps: [
          `Navigate to ${location}`,
          "Enable screen reader",
          `Observe: element announced as "${context.targetPath}"`,
        ],
      });
    }

    // UX: Keyboard trap — modal without dismiss handler
    if (
      /<(?:Modal|Dialog|Overlay)\b/i.test(sourceCode) &&
      !/(?:onRequestClose|dismiss|close|onClose)/i.test(sourceCode)
    ) {
      bugs.push({
        id: `ui-bug-${Date.now()}-6`,
        severity: "medium",
        category: "ux",
        description: "Modal/Dialog without dismiss handler may trap keyboard focus",
        location: context.targetPath,
        screenshot,
        reproductionSteps: [
          `Navigate to ${location}`,
          "Open the modal",
          "Press Escape or back button",
          "Observe: modal does not close",
        ],
      });
    }
  }

  // Next action suggestion for driving the flow
  const isSubmitVisible = await driver.isVisible("button");
  if (isSubmitVisible && context.currentFlow === "initial_view") {
    nextAction = "click button";
  }

  const observation = `Screen at ${location} rendered in flow "${context.currentFlow}". ${
    bugs.length > 0 ? `Identified ${bugs.length} potential UI/UX issue(s).` : "Layout appears stable."
  }`;

  return {
    observation,
    bugs,
    nextAction,
  };
}
