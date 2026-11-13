import * as fs from "fs";
import * as path from "path";
import { TestFramework } from "./types";

/**
 * Locate the nearest directory containing package.json by walking upwards.
 */
export function findProjectRoot(startDir: string): string {
  let curr = path.resolve(startDir);
  try {
    if (fs.existsSync(curr) && fs.statSync(curr).isFile()) {
      curr = path.dirname(curr);
    }
  } catch {
    // Ignore stat errors
  }

  const initialDir = curr;
  let depth = 0;
  const maxDepth = 10;

  while (depth < maxDepth) {
    const pkgPath = path.join(curr, "package.json");
    if (fs.existsSync(pkgPath)) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
    depth++;
  }

  return initialDir;
}

/**
 * Detect the test framework from a project's package.json.
 * Traverses upwards with a bounded search depth.
 */
export function detectFramework(projectRoot: string): TestFramework {
  const rootDir = findProjectRoot(projectRoot);
  const pkgPath = path.join(rootDir, "package.json");

  if (!fs.existsSync(pkgPath)) return "jest";

  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    if (allDeps.vitest || allDeps.vite) return "vitest";
    if (allDeps.jest || allDeps["react-native"] || allDeps.expo) return "jest";
  } catch {
    // Fall back to jest
  }

  return "jest";
}

/**
 * Detect whether the target is React Native vs React Web based on imports or package.json dependencies.
 */
export function isReactNativeProject(projectRoot?: string, code?: string): boolean {
  if (code) {
    if (
      code.includes("from 'react-native'") ||
      code.includes('from "react-native"') ||
      code.includes("from 'expo") ||
      code.includes('from "expo') ||
      code.includes("@react-navigation")
    ) {
      return true;
    }
    if (
      code.includes("from 'react-dom'") ||
      code.includes('from "react-dom"') ||
      code.includes("react-router-dom") ||
      /<(div|span|button|input|form|section|main|header|footer|h[1-6]|p|ul|li|table|a|img)\b/.test(
        code,
      ) ||
      /\b(window\.matchMedia|document\.documentElement|document\.cookie|localStorage\.)/.test(
        code,
      )
    ) {
      return false;
    }
  }

  if (projectRoot) {
    const rootDir = findProjectRoot(projectRoot);
    const pkgPath = path.join(rootDir, "package.json");

    if (fs.existsSync(pkgPath)) {
      try {
        const raw = fs.readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(raw);
        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        };

        if (allDeps["react-native"] || allDeps["expo"]) {
          return true;
        }
        if (
          allDeps["react-dom"] ||
          allDeps["vite"] ||
          allDeps["@vitejs/plugin-react"] ||
          allDeps["jsdom"] ||
          allDeps["happy-dom"] ||
          allDeps["@testing-library/react"] ||
          allDeps["next"]
        ) {
          return false;
        }
      } catch {
        // Fall back
      }
    }
  }

  return true;
}

/**
 * Detect whether the target project has a DOM test environment and testing library.
 */
export function detectDomEnvironment(projectRoot?: string): {
  hasDomRunner: boolean;
  hasTestingLibrary: boolean;
  preferredDomEnv: "jsdom" | "happy-dom";
} {
  if (!projectRoot) {
    return {
      hasDomRunner: false,
      hasTestingLibrary: false,
      preferredDomEnv: "happy-dom",
    };
  }

  const rootDir = findProjectRoot(projectRoot);
  const pkgPath = path.join(rootDir, "package.json");

  if (!fs.existsSync(pkgPath)) {
    return {
      hasDomRunner: false,
      hasTestingLibrary: false,
      preferredDomEnv: "happy-dom",
    };
  }

  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    const hasJsdom = Boolean(allDeps["jsdom"]);
    const hasHappyDom = Boolean(
      allDeps["happy-dom"] || allDeps["@happy-dom/global-registrator"],
    );
    const hasDomRunner = hasJsdom || hasHappyDom;
    const hasTestingLibrary = Boolean(
      allDeps["@testing-library/react"] ||
        allDeps["@testing-library/react-native"],
    );
    const preferredDomEnv =
      hasJsdom && !hasHappyDom ? "jsdom" : "happy-dom";

    return { hasDomRunner, hasTestingLibrary, preferredDomEnv };
  } catch {
    return {
      hasDomRunner: false,
      hasTestingLibrary: false,
      preferredDomEnv: "happy-dom",
    };
  }
}
