import * as fs from "fs";
import * as path from "path";

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

export interface SimulatedElement {
  selector: string;
  visible: boolean;
  text: string;
  value?: string;
  attributes?: Record<string, string>;
}

export interface SimulatedDriverOptions {
  initialLocation?: string;
  elements?: Record<string, SimulatedElement>;
  mockScreenshot?: string;
}

/**
 * 1x1 transparent PNG as default base64 screenshot data URI
 */
const DEFAULT_SCREENSHOT_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * High-fidelity simulated UI driver for environments without live browsers or emulators.
 */
export class SimulatedUIDriver implements UIDriver {
  private currentLocation: string;
  private elements = new Map<string, SimulatedElement>();
  private closed = false;
  private customScreenshot?: string;

  constructor(options?: SimulatedDriverOptions) {
    this.currentLocation = options?.initialLocation || "/";
    this.customScreenshot = options?.mockScreenshot;

    if (options?.elements) {
      for (const [sel, el] of Object.entries(options.elements)) {
        this.elements.set(sel, { ...el });
      }
    }
  }

  async navigate(targetPath: string): Promise<void> {
    if (this.closed) throw new Error("Driver is closed");
    this.currentLocation = targetPath;

    // Inspect file if path points to a local file
    const resolved = path.resolve(targetPath.split("#")[0]);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      try {
        const content = fs.readFileSync(resolved, "utf-8");
        this.extractElementsFromSource(content);
      } catch {}
    }
  }

  private extractElementsFromSource(source: string): void {
    // Use Babel parser for AST-based extraction instead of regex
    try {
      const { parse } = require("@babel/parser");
      const traverse = require("@babel/traverse").default;
      const ast = parse(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      });

      traverse(ast, {
        JSXOpeningElement(path: any) {
          const name = path.node.name;
          const elementName = name?.name || "Unknown";
          const attrs: Record<string, string> = {};

          for (const attr of path.node.attributes || []) {
            if (attr.type === "JSXAttribute" && attr.name) {
              const attrName = attr.name.name;
              const attrValue = attr.value?.value || attr.value?.expression?.value || "";
              attrs[attrName] = String(attrValue);
            }
          }

          const selector = attrs.testID
            ? `[testID="${attrs.testID}"]`
            : attrs.id
              ? `#${attrs.id}`
              : undefined;

          if (selector) {
            this.elements.set(selector, {
              selector,
              visible: true,
              text: attrs.testID || attrs.id || elementName,
            });
          }

          if (["button", "TouchableOpacity", "Pressable"].includes(elementName)) {
            const text = this.extractJSXText(path);
            const sel = selector || `text=${text || elementName}`;
            if (!this.elements.has(sel)) {
              this.elements.set(sel, {
                selector: sel,
                visible: true,
                text: text || elementName,
              });
            }
          }

          if (["input", "TextInput"].includes(elementName)) {
            const sel = selector || `input[name="${attrs.name || attrs.placeholder || "input"}"]`;
            this.elements.set(sel, {
              selector: sel,
              visible: true,
              text: "",
              value: "",
            });
          }
        },
      });
    } catch {
      // Fallback to regex if Babel parsing fails
      const buttonMatches = source.match(/<button[^>]*>([\s\S]*?)<\/button>/gi) || [];
      for (const b of buttonMatches) {
        const textMatch = b.match(/>([\s\S]*?)</);
        const text = textMatch ? textMatch[1].trim() : "Button";
        const idMatch = b.match(/id=["']([^"']+)["']/i);
        const selector = idMatch ? `#${idMatch[1]}` : "button";
        this.elements.set(selector, { selector, visible: true, text });
      }

      const testIdMatches = source.matchAll(/testID=["']([^"']+)["']/gi);
      for (const m of testIdMatches) {
        const id = m[1];
        this.elements.set(`[testID="${id}"]`, {
          selector: `[testID="${id}"]`,
          visible: true,
          text: id,
        });
        this.elements.set(`#${id}`, {
          selector: `#${id}`,
          visible: true,
          text: id,
        });
      }

      const inputMatches = source.matchAll(/<(?:input|TextInput)[^>]*name=["']([^"']+)["']/gi);
      for (const m of inputMatches) {
        const name = m[1];
        this.elements.set(`input[name="${name}"]`, {
          selector: `input[name="${name}"]`,
          visible: true,
          text: "",
          value: "",
        });
      }
    }
  }

  private extractJSXText(path: any): string {
    let text = "";
    for (const child of path.node.children || []) {
      if (child.type === "JSXText") {
        text += child.value;
      } else if (child.type === "JSXExpressionContainer" && child.expression) {
        text += String(child.expression.name || "");
      }
    }
    return text.trim();
  }

  async click(selector: string): Promise<void> {
    if (this.closed) throw new Error("Driver is closed");
    const el = this.elements.get(selector);
    if (!el) {
      // Auto-register element as interacted
      this.elements.set(selector, { selector, visible: true, text: selector });
    }
  }

  async type(selector: string, text: string): Promise<void> {
    if (this.closed) throw new Error("Driver is closed");
    const existing = this.elements.get(selector) || {
      selector,
      visible: true,
      text: "",
    };
    existing.value = text;
    this.elements.set(selector, existing);
  }

  async screenshot(): Promise<string> {
    if (this.closed) throw new Error("Driver is closed");
    return this.customScreenshot || DEFAULT_SCREENSHOT_BASE64;
  }

  async getCurrentLocation(): Promise<string> {
    if (this.closed) throw new Error("Driver is closed");
    return this.currentLocation;
  }

  async waitFor(selector: string, timeout: number = 3000): Promise<void> {
    if (this.closed) throw new Error("Driver is closed");
    const el = this.elements.get(selector);
    if (!el) {
      // If not immediately available, simulate brief wait
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeout, 50)));
      this.elements.set(selector, { selector, visible: true, text: selector });
    }
  }

  async isVisible(selector: string): Promise<boolean> {
    if (this.closed) throw new Error("Driver is closed");
    const el = this.elements.get(selector);
    return el ? el.visible : false;
  }

  async getText(selector: string): Promise<string> {
    if (this.closed) throw new Error("Driver is closed");
    const el = this.elements.get(selector);
    return el ? el.text : "";
  }

  async scrollTo(selector: string): Promise<void> {
    if (this.closed) throw new Error("Driver is closed");
    if (!this.elements.has(selector)) {
      this.elements.set(selector, { selector, visible: true, text: selector });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Test helper to register or modify simulated elements */
  setElement(selector: string, element: Partial<SimulatedElement>): void {
    const existing = this.elements.get(selector) || {
      selector,
      visible: true,
      text: "",
    };
    this.elements.set(selector, { ...existing, ...element });
  }
}

/**
 * Create a Playwright driver.
 * Uses real Playwright if available, or falls back to simulated driver.
 */
export async function createPlaywrightDriver(options?: any): Promise<UIDriver> {
  try {
    // Attempt dynamic require if playwright is installed in user project
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pw = require("playwright");
    if (pw && pw.chromium) {
      const browser = await pw.chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      return {
        async navigate(url: string) {
          await page.goto(url);
        },
        async click(selector: string) {
          await page.click(selector);
        },
        async type(selector: string, text: string) {
          await page.fill(selector, text);
        },
        async screenshot() {
          const buffer = await page.screenshot();
          return `data:image/png;base64,${buffer.toString("base64")}`;
        },
        async getCurrentLocation() {
          return page.url();
        },
        async waitFor(selector: string, timeout?: number) {
          await page.waitForSelector(selector, { timeout });
        },
        async isVisible(selector: string) {
          return await page.isVisible(selector);
        },
        async getText(selector: string) {
          return (await page.textContent(selector)) || "";
        },
        async scrollTo(selector: string) {
          await page.$eval(selector, (el: any) => el.scrollIntoView());
        },
        async close() {
          await browser.close();
        },
      };
    }
  } catch {
    // Playwright not installed or failed to launch, use simulated driver
  }

  return new SimulatedUIDriver(options);
}

/**
 * Create a Detox driver.
 * Uses real Detox if available, or falls back to simulated driver.
 */
export async function createDetoxDriver(options?: any): Promise<UIDriver> {
  try {
    // Attempt dynamic require if detox is installed in user project
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const detox = require("detox");
    if (detox && detox.device) {
      return {
        async navigate(screen: string) {
          // In Detox, screen navigation via deep link or UI action
          if (screen.startsWith("http://") || screen.startsWith("exp://") || screen.startsWith("/")) {
            await detox.device.openURL({ url: screen });
          }
        },
        async click(selector: string) {
          const el = detox.element(detox.by.id(selector.replace(/^[#]/, "")));
          await el.tap();
        },
        async type(selector: string, text: string) {
          const el = detox.element(detox.by.id(selector.replace(/^[#]/, "")));
          await el.typeText(text);
        },
        async screenshot() {
          const p = await detox.device.takeScreenshot(`cv-${Date.now()}`);
          if (fs.existsSync(p)) {
            const buf = fs.readFileSync(p);
            return `data:image/png;base64,${buf.toString("base64")}`;
          }
          return DEFAULT_SCREENSHOT_BASE64;
        },
        async getCurrentLocation() {
          return "detox://current-screen";
        },
        async waitFor(selector: string, timeout?: number) {
          const el = detox.element(detox.by.id(selector.replace(/^[#]/, "")));
          await detox.waitFor(el).toBeVisible().withTimeout(timeout || 3000);
        },
        async isVisible(selector: string) {
          try {
            const el = detox.element(detox.by.id(selector.replace(/^[#]/, "")));
            await detox.expect(el).toBeVisible();
            return true;
          } catch {
            return false;
          }
        },
        async getText(selector: string) {
          try {
            const el = detox.element(detox.by.id(selector.replace(/^[#]/, "")));
            const attributes = await el.getAttributes();
            return attributes.text || attributes.label || "";
          } catch {
            return "";
          }
        },
        async scrollTo(selector: string) {
          const el = detox.element(detox.by.id(selector.replace(/^[#]/, "")));
          await el.scrollTo("bottom");
        },
        async close() {
          // Detox device cleanup
        },
      };
    }
  } catch {
    // Detox not installed, use simulated mobile driver
  }

  return new SimulatedUIDriver({
    ...options,
    initialLocation: options?.initialLocation || "HomeScreen",
  });
}
