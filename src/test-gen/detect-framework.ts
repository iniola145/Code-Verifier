import * as fs from "fs";
import * as path from "path";
import { TestFramework } from "./types";

/**
 * Detect the test framework from a project's package.json.
 * Traverses upwards with a bounded search depth.
 */
export function detectFramework(projectRoot: string): TestFramework {
  let curr = path.resolve(projectRoot);
  let pkgPath = path.join(curr, "package.json");
  let depth = 0;
  const maxDepth = 10;

  // Traverse upward to locate package.json with depth limit
  while (!fs.existsSync(pkgPath) && depth < maxDepth) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
    pkgPath = path.join(curr, "package.json");
    depth++;
  }

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
      code.includes("react-router-dom")
    ) {
      return false;
    }
  }

  if (projectRoot) {
    let curr = path.resolve(projectRoot);
    let pkgPath = path.join(curr, "package.json");
    let depth = 0;
    const maxDepth = 10;

    while (!fs.existsSync(pkgPath) && depth < maxDepth) {
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
      pkgPath = path.join(curr, "package.json");
      depth++;
    }

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
} {
  if (!projectRoot) return { hasDomRunner: false, hasTestingLibrary: false };

  let curr = path.resolve(projectRoot);
  let pkgPath = path.join(curr, "package.json");
  let depth = 0;
  const maxDepth = 10;

  while (!fs.existsSync(pkgPath) && depth < maxDepth) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
    pkgPath = path.join(curr, "package.json");
    depth++;
  }

  if (!fs.existsSync(pkgPath)) return { hasDomRunner: false, hasTestingLibrary: false };

  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    const hasDomRunner = Boolean(
      allDeps["jsdom"] || allDeps["happy-dom"] || allDeps["@happy-dom/global-registrator"]
    );
    const hasTestingLibrary = Boolean(
      allDeps["@testing-library/react"] || allDeps["@testing-library/react-native"]
    );

    return { hasDomRunner, hasTestingLibrary };
  } catch {
    return { hasDomRunner: false, hasTestingLibrary: false };
  }
}
