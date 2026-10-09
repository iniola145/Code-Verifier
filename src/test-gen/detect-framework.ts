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

    if (allDeps.vitest) return "vitest";
    if (allDeps.jest || allDeps["react-native"] || allDeps.expo) return "jest";
  } catch {
    // Fall back to jest
  }

  return "jest";
}
