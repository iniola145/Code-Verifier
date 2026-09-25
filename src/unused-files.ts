import * as fs from "fs";
import * as path from "path";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parseSourceCode } from "./parser/ast";

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * File basenames that act as framework or tooling entry points. They are
 * discovered by convention (platform, bundler, test runner) rather than
 * imported, so HYG-004 must stay quiet on them.
 */
const ENTRY_STEMS = new Set([
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

/**
 * Path segments whose files are conventionally discovered rather than
 * imported: test runners, mocks, and storybook load stories by pattern.
 */
const EXEMPT_SEGMENTS = new Set([
  "__tests__",
  "__mocks__",
  "test",
  "tests",
  "storybook",
  "stories",
  // Expo Router / Next.js-style route directories: files there are discovered
  // by the framework's file-based routing, not imported.
  "app",
  "pages",
]);

function isExemptFile(file: string): boolean {
  const base = path.basename(file);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  if (/\.(test|spec|stories|config|setup)$/.test(stem)) return true;
  if (ENTRY_STEMS.has(stem)) return true;
  const segments = file.split(/[\\/]/);
  return segments.some((seg) => EXEMPT_SEGMENTS.has(seg));
}

/**
 * Project-wide import graph used by the HYG-004 orphaned-file rule. Built once
 * per run from the same file list the per-file rules scan, so a file counts as
 * orphaned only when nothing else in the scanned set resolves to it.
 */
export class ImportGraphIndex {
  /** Scanned file -> resolved absolute paths it imports. */
  private readonly imports: Map<string, Set<string>> = new Map();
  /** Scanned file -> resolved absolute paths importing it. */
  private readonly importedBy: Map<string, Set<string>> = new Map();
  private readonly known: Set<string>;

  private constructor(known: Set<string>) {
    this.known = known;
  }

  static fromFiles(files: string[]): ImportGraphIndex {
    const index = new ImportGraphIndex(new Set(files.map((f) => path.resolve(f))));
    for (const importer of files) index.addFile(importer);
    for (const [file, targets] of index.imports) {
      for (const target of targets) {
        let set = index.importedBy.get(target);
        if (!set) {
          set = new Set();
          index.importedBy.set(target, set);
        }
        set.add(file);
      }
    }
    return index;
  }

  /**
   * True when some other scanned file imports this one. Exempt files (entry
   * points, configs, tests, stories) are always treated as reachable.
   */
  isReachable(filePath: string): boolean {
    const key = path.resolve(filePath);
    if (isExemptFile(key)) return true;
    const importers = this.importedBy.get(key);
    return !!importers && importers.size > 0;
  }

  /** Files that import the given file (diagnostic message support). */
  importedByOf(filePath: string): string[] {
    const importers = this.importedBy.get(path.resolve(filePath));
    return importers ? [...importers] : [];
  }

  private addFile(file: string): void {
    let code: string;
    try {
      code = fs.readFileSync(file, "utf-8");
    } catch {
      return;
    }
    let ast: t.File;
    try {
      ast = parseSourceCode(code, file).ast;
    } catch {
      return; // Unparseable files import nothing we can map.
    }
    traverse(ast, {
      ImportDeclaration: (path) => {
        this.recordImport(file, path.node.source.value);
      },
      ExportNamedDeclaration: (path) => {
        if (path.node.source) this.recordImport(file, path.node.source.value);
      },
      ExportAllDeclaration: (path) => {
        if (path.node.source) this.recordImport(file, path.node.source.value);
      },
      CallExpression: (path) => {
        const callee = path.node.callee;
        if (!t.isIdentifier(callee, { name: "require" })) return;
        const arg = path.node.arguments[0];
        if (t.isStringLiteral(arg)) this.recordImport(file, arg.value);
      },
    });
  }

  private recordImport(file: string, specifier: string): void {
    const target = this.resolve(specifier, path.dirname(file));
    if (!target) return;
    let set = this.imports.get(file);
    if (!set) {
      set = new Set();
      this.imports.set(file, set);
    }
    set.add(target);
  }

  /**
   * Resolve a relative specifier against the importing file's directory using
   * Node-style extension and index-file resolution, restricted to the scanned
   * file set. Bare specifiers (packages) resolve to nothing.
   */
  private resolve(specifier: string, fromDir: string): string | null {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
    const base = path.resolve(fromDir, specifier);
    if (this.known.has(base)) return base;
    for (const ext of RESOLVE_EXTENSIONS) {
      if (this.known.has(base + ext)) return base + ext;
    }
    for (const ext of RESOLVE_EXTENSIONS) {
      const indexCandidate = path.join(base, "index" + ext);
      if (this.known.has(indexCandidate)) return indexCandidate;
    }
    return null;
  }
}
