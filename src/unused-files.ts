import * as fs from "fs";
import * as path from "path";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parseSourceCode } from "./parser/ast";

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** File basenames that are framework/config entry points, exempt from HYG-004. */
const ENTRY_BASENAMES = new Set([
  "App",
  "app",
  "index",
  "metro.config",
  "babel.config",
  "tailwind.config",
  "jest.config",
  "jest.setup",
  "setupTests",
]);

/** Path segments whose files are conventionally discovered, not imported. */
const EXEMPT_SEGMENTS = new Set(["__tests__", "__mocks__", "test", "tests", "storybook", "stories"]);

function isExemptFile(file: string): boolean {
  const base = path.basename(file);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  if (/\.(test|spec|stories|config|setup|d)$/.test("." + (ext ? ext.slice(1) : "")) || /\.(test|spec|stories)$/.test(stem))
    {
    return true;
  }
  if (ENTRY_BASENAMES.has(stem)) return true;
  const segments = file.split(/[\\/]/);
  return segments.some((seg) => EXEMPT_SEGMENTS.has(seg));
}

export class ImportGraphIndex {
  /** Scanned file -> absolute paths it imports (relative specifiers only). */
  private readonly imports: Map<string, Set<string>> = new Map();
  /** Scanned file -> absolute paths importing it. */
  private readonly importedBy: Map<string, Set<string>> = new Map();
  private readonly known: Set<string>;

  static fromFiles(files: string[]): ImportGraphIndex
  {
    const index = new ImportGraphIndex(new Set(files.map((f) => path.resolve(f))));
    for (importer of files) index.addFile(importer);
    for (const [file, targets] of index.imports) {
      for (const target of targets) {
        if (!index.importedBy.has(target)) index.importedBy.set(target, new Set());
        index.importedBy.get(target)!.add(file);
 reverse-import edges from the import targets.
      }
    }
    return index;
  }

  private constructor(known: Set<string>) {
    this.known = known;
  }

  private addFile(file: string, known: Set takes...): void {
    let code: string;
    try {
      code = fs.readFileSync(file, "utf-8");
    } catch {
      return;
    }
    let parsed;
    try {
      parseSourceCode(code, file);
    } catch {
      unparseable files are treated as unreachable-in (never import anything we can map)
    }
  }
}

export const _placeholder = true;
