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
  "main",
  "_layout",
  "metro.config",
  "babel.config",
  "tailwind.config",
  "jest.config",
  "jest.setup",
  "setupTests",
  // Service workers are registered through browser APIs or build plugins
  // (vite-plugin-pwa `injectManifest` with `srcDir: "src", filename: "sw.ts"`,
  // Workbox generate-service-worker), never imported by app code.
  "sw",
  "serviceWorker",
  "service-worker",
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
  // Platform-specific variants (File.android.tsx etc.) are selected by the
  // bundler from the base specifier, so the base import edge covers them.
  if (/\.(android|ios|native|web)$/.test(stem)) return true;
  // Standalone tooling scripts (.mjs/.cjs) are executed, not imported.
  if (ext === ".mjs" || ext === ".cjs") return true;
  // Expo convention: "_"-prefixed files are private framework entries
  // (_layout, _fabric-native-components, ...) referenced by tooling.
  if (stem.startsWith("_")) return true;
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
  /** Scanned file -> resolved absolute paths it re-exports without local use. */
  private readonly reExports: Map<string, Set<string>> = new Map();
  /** Re-export target -> scanned files that re-export it. */
  private readonly reExportedBy: Map<string, Set<string>> = new Map();
  /** Re-exporter -> target -> exposed names; null means export-all. */
  private readonly reExportedNames: Map<string, Map<string, Set<string> | null>> =
    new Map();
  /** Importer -> imported module -> imported names; null means whole module. */
  private readonly importedNames: Map<string, Map<string, Set<string> | null>> =
    new Map();
  /** File -> top-level value export names. */
  private readonly exportedNames: Map<string, Set<string>> = new Map();
  private readonly known: Set<string>;
  /** Files launched by package.json scripts/bin fields rather than imported. */
  private readonly packageEntrypoints: Set<string> = new Set();
  /** Loaded tsconfig path mappings, e.g. "@/*" -> "<root>/src/*". */
  private readonly aliasPatterns: { prefix: string; targets: string[] }[] = [];

  private constructor(known: Set<string>, projectRoot?: string) {
    this.known = known;
    this.aliasPatterns = projectRoot ? loadTsconfigPaths(projectRoot) : [];
    if (projectRoot)
      this.packageEntrypoints = loadPackageEntrypoints(projectRoot, known);
  }

  static fromFiles(files: string[], projectRoot?: string): ImportGraphIndex {
    const index = new ImportGraphIndex(
      new Set(files.map((f) => path.resolve(f))),
      projectRoot,
    );
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
    for (const [file, targets] of index.reExports) {
      for (const target of targets) {
        let set = index.reExportedBy.get(target);
        if (!set) {
          set = new Set();
          index.reExportedBy.set(target, set);
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
    if (this.packageEntrypoints.has(key)) return true;
    const importers = this.importedBy.get(key);
    if (importers && importers.size > 0) return true;
    if (this.isReachableThroughReExport(key, new Set(), null)) return true;

    // Metro resolves extensionless imports to platform-specific siblings at
    // bundle time. If `./Widget` resolves to Widget.tsx in this syntax-only
    // graph, Widget.android.tsx / Widget.ios.tsx are still live alternatives.
    const platformMatch = key.match(
      /^(.*)\.(android|ios|native|web)(\.[^.]+)$/,
    );
    if (platformMatch) {
      const base = platformMatch[1];
      for (const ext of RESOLVE_EXTENSIONS) {
        const baseImporters = this.importedBy.get(base + ext);
        if (baseImporters && baseImporters.size > 0) return true;
        if (this.isReachableThroughReExport(base + ext, new Set(), null))
          return true;
      }
    }
    return false;
  }

  /** Files that import the given file (diagnostic message support). */
  importedByOf(filePath: string): string[] {
    const importers = this.importedBy.get(path.resolve(filePath));
    return importers ? [...importers] : [];
  }

  private addFile(file: string): void {
    const exports = new Set<string>();
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
        this.recordImport(
          file,
          path.node.source.value,
          importedNamesFrom(path.node),
        );
      },
      ExportNamedDeclaration: (path) => {
        if (path.node.source)
          this.recordReExport(
            file,
            path.node.source.value,
            reExportedNamesFrom(path.node),
          );
        else recordLocalExportNames(exports, path.node);
      },
      ExportAllDeclaration: (path) => {
        if (path.node.source)
          this.recordReExport(file, path.node.source.value, null);
      },
      ExportDefaultDeclaration: () => {
        exports.add("default");
      },
      CallExpression: (path) => {
        const callee = path.node.callee;
        if (!t.isIdentifier(callee, { name: "require" })) return;
        const arg = path.node.arguments[0];
        if (t.isStringLiteral(arg)) this.recordImport(file, arg.value, null);
      },
    });
    this.exportedNames.set(path.resolve(file), exports);
  }

  private recordImport(
    file: string,
    specifier: string,
    names: Set<string> | null,
  ): void {
    const target = this.resolve(specifier, path.dirname(file));
    if (!target) return;
    const key = path.resolve(file);
    let set = this.imports.get(key);
    if (!set) {
      set = new Set();
      this.imports.set(key, set);
    }
    set.add(target);

    let byTarget = this.importedNames.get(key);
    if (!byTarget) {
      byTarget = new Map();
      this.importedNames.set(key, byTarget);
    }
    const existing = byTarget.get(target);
    if (existing === null || names === null) {
      byTarget.set(target, null);
      return;
    }
    if (!existing) byTarget.set(target, new Set(names));
    else for (const name of names) existing.add(name);
  }

  private recordReExport(
    file: string,
    specifier: string,
    names: Set<string> | null,
  ): void {
    const target = this.resolve(specifier, path.dirname(file));
    if (!target) return;
    const key = path.resolve(file);
    let set = this.reExports.get(key);
    if (!set) {
      set = new Set();
      this.reExports.set(key, set);
    }
    set.add(target);

    let byTarget = this.reExportedNames.get(key);
    if (!byTarget) {
      byTarget = new Map();
      this.reExportedNames.set(key, byTarget);
    }
    // A barrel can re-export the same target more than once (`export { X }`
    // + `export type { XProps }`). Merge the name sets; a null (star or
    // namespace re-export — exposes anything) dominates. A blind overwrite
    // here drops the value names and strands the re-exported file.
    const existing = byTarget.get(target);
    if (existing === null || names === null) {
      byTarget.set(target, null);
      return;
    }
    if (!existing) byTarget.set(target, new Set(names));
    else for (const name of names) existing.add(name);
  }

  private isReachableThroughReExport(
    file: string,
    seen: Set<string>,
    demandedNames: Set<string> | null,
  ): boolean {
    const key = path.resolve(file);
    if (seen.has(key)) return false;
    seen.add(key);
    const reExporters = this.reExportedBy.get(key);
    if (!reExporters) return false;
    for (const barrel of reExporters) {
      const exposedNames = this.exposedNamesForReExport(barrel, key);
      if (!namesCanSatisfy(exposedNames, demandedNames)) continue;
      const directBarrelImporters = this.importedBy.get(barrel);
      if (
        directBarrelImporters &&
        [...directBarrelImporters].some((importer) =>
          this.importCanUseReExport(importer, barrel, exposedNames),
        )
      )
        return true;
      if (this.isReachableThroughReExport(barrel, seen, exposedNames))
        return true;
    }
    return false;
  }

  private exposedNamesForReExport(
    barrel: string,
    target: string,
  ): Set<string> | null {
    const declared = this.reExportedNames.get(barrel)?.get(target);
    if (declared !== null && declared !== undefined) return declared;
    // `export * from target`: the barrel exposes the target's whole public
    // surface — its local exports plus everything the target itself pulls in
    // through its own `export *` / `export {x} from` chains. Matching only on
    // the target's local exports misses chained star re-exports (index ->
    // service -> sibling service re-exported through `export *`), which made
    // genuinely consumed modules look orphaned.
    return this.publicSurface(target, new Set());
  }

  /**
   * The names a module makes available to its importers: its local exports
   * plus, transitively, every name exposed through its own re-exports. Returns
   * null when the surface cannot be enumerated (a re-export cycle or an
   * unknown target), which callers treat permissively rather than as an empty
   * set — an under-approximated list here re-creates orphaned-file false
   * positives on barrel files.
   */
  private publicSurface(file: string, seen: Set<string>): Set<string> | null {
    const key = path.resolve(file);
    if (seen.has(key)) return null; // re-export cycle: surface unknown
    seen.add(key);
    const surface = new Set<string>(this.exportedNames.get(key) ?? []);
    const targets = this.reExports.get(key);
    if (targets) {
      for (const target of targets) {
        const declared = this.reExportedNames.get(key)?.get(target);
        if (declared !== null && declared !== undefined) {
          for (const name of declared) surface.add(name);
          continue;
        }
        const nested = this.publicSurface(target, seen);
        if (nested === null) return null; // unknown part: stay permissive
        for (const name of nested) surface.add(name);
      }
    }
    return surface.size > 0 ? surface : null;
  }

  private importCanUseReExport(
    importer: string,
    barrel: string,
    exposedNames: Set<string> | null,
  ): boolean {
    const names = this.importedNames.get(importer)?.get(barrel);
    if (names === null) return true;
    return namesCanSatisfy(exposedNames, names ?? new Set());
  }

  /**
   * Resolve a relative specifier against the importing file's directory using
   * Node-style extension and index-file resolution, restricted to the scanned
   * file set. Bare specifiers (packages) resolve to nothing.
   */
  private resolve(specifier: string, fromDir: string): string | null {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      return this.resolveRelative(path.resolve(fromDir, specifier));
    }
    for (const alias of this.aliasPatterns) {
      if (!specifier.startsWith(alias.prefix)) continue;
      for (const target of alias.targets) {
        const base = path.resolve(target, specifier.slice(alias.prefix.length));
        const hit = this.resolveRelative(base);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Node-style extension and index-file resolution against the scan set. */
  private resolveRelative(base: string): string | null {
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

function importedNamesFrom(node: t.ImportDeclaration): Set<string> | null {
  if (node.specifiers.length === 0) return null;
  const names = new Set<string>();
  for (const spec of node.specifiers) {
    if (t.isImportSpecifier(spec)) {
      if (t.isIdentifier(spec.imported)) names.add(spec.imported.name);
      else names.add(spec.imported.value);
    } else if (t.isImportDefaultSpecifier(spec)) {
      names.add("default");
    } else if (t.isImportNamespaceSpecifier(spec)) {
      return null;
    }
  }
  return names;
}

function reExportedNamesFrom(
  node: t.ExportNamedDeclaration,
): Set<string> | null {
  const names = new Set<string>();
  for (const spec of node.specifiers) {
    if (!t.isExportSpecifier(spec)) continue;
    if (t.isIdentifier(spec.exported)) names.add(spec.exported.name);
    else names.add(spec.exported.value);
  }
  return names.size > 0 ? names : null;
}

function namesCanSatisfy(
  exposedNames: Set<string> | null,
  demandedNames: Set<string> | null,
): boolean {
  if (exposedNames === null || demandedNames === null) return true;
  for (const name of demandedNames) if (exposedNames.has(name)) return true;
  return false;
}

function recordLocalExportNames(
  exports: Set<string>,
  node: t.ExportNamedDeclaration,
): void {
  if (node.declaration) {
    const declaration = node.declaration;
    if (
      (t.isFunctionDeclaration(declaration) ||
        t.isClassDeclaration(declaration)) &&
      declaration.id
    )
      exports.add(declaration.id.name);
    if (t.isVariableDeclaration(declaration))
      for (const item of declaration.declarations)
        if (t.isIdentifier(item.id)) exports.add(item.id.name);
    return;
  }
  for (const spec of node.specifiers) {
    if (t.isExportSpecifier(spec)) {
      if (t.isIdentifier(spec.exported)) exports.add(spec.exported.name);
      else exports.add(spec.exported.value);
    }
  }
}

/**
 * Finds source files executed directly by package-manager scripts or exposed as
 * package entry points. These files are roots of the project graph even though
 * no source module imports them (for example `tsx server/mcp.ts`).
 */
function loadPackageEntrypoints(
  projectRoot: string,
  known: Set<string>,
): Set<string> {
  const result = new Set<string>();
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"),
    );
    const candidates: string[] = [];
    if (packageJson.scripts && typeof packageJson.scripts === "object") {
      for (const command of Object.values(packageJson.scripts))
        if (typeof command === "string") {
          for (const match of command.matchAll(
            /(?:^|[\s"'=])((?:\.\/)?[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs))(?=$|[\s"';&|])/g,
          ))
            candidates.push(match[1]);
        }
    }
    for (const field of [packageJson.main, packageJson.module])
      if (typeof field === "string") candidates.push(field);
    if (typeof packageJson.bin === "string") candidates.push(packageJson.bin);
    else if (packageJson.bin && typeof packageJson.bin === "object")
      for (const value of Object.values(packageJson.bin))
        if (typeof value === "string") candidates.push(value);
    for (const candidate of candidates) {
      const resolved = path.resolve(projectRoot, candidate);
      if (known.has(resolved)) result.add(resolved);
    }
  } catch {
    // Missing or malformed package metadata cannot establish an entry point.
  }
  return result;
}

/**
 * Loads compilerOptions.paths from the project's tsconfig.json so aliased
 * imports ("@/shared/utils") resolve like the bundler resolves them. Patterns
 * are reduced to a literal prefix + target base pairs; only single-star
 * patterns are handled, which covers the common "@/*" and "~/*" conventions.
 */
function loadTsconfigPaths(
  projectRoot: string,
): { prefix: string; targets: string[] }[] {
  const patterns: { prefix: string; targets: string[] }[] = [];
  const visited = new Set<string>();
  collectTsconfigPaths(
    path.join(projectRoot, "tsconfig.json"),
    patterns,
    visited,
  );
  return patterns;
}

/**
 * Recursively collects path mappings from a tsconfig and the configs it
 * references or extends. Root tsconfig.json files in Vite/Expo projects are
 * often just "references" shells with the real compilerOptions.paths in
 * tsconfig.app.json / tsconfig.node.json, so following references is required
 * for alias resolution there.
 */
function collectTsconfigPaths(
  configPath: string,
  patterns: { prefix: string; targets: string[] }[],
  visited: Set<string>,
): void {
  const resolvedPath = path.resolve(configPath);
  if (visited.has(resolvedPath)) return;
  visited.add(resolvedPath);
  let config: any;
  try {
    config = JSON.parse(
      stripJsonComments(fs.readFileSync(resolvedPath, "utf-8")),
    );
  } catch {
    return; // Unreadable configs simply contribute no mappings.
  }
  const compilerOptions = config?.compilerOptions ?? {};
  const baseDir = path.dirname(resolvedPath);

  // "extends": inherited paths apply, unless overridden locally.
  if (typeof config.extends === "string") {
    const extendsTarget = config.extends.endsWith(".json")
      ? config.extends
      : config.extends + ".json";
    collectTsconfigPaths(
      path.resolve(baseDir, extendsTarget),
      patterns,
      visited,
    );
  }

  const paths = compilerOptions.paths as Record<string, string[]> | undefined;
  if (paths) {
    for (const [pattern, targets] of Object.entries(paths)) {
      const starIndex = pattern.indexOf("*");
      const prefix = starIndex === -1 ? pattern : pattern.slice(0, starIndex);
      const resolvedTargets = (targets as string[]).map((target) => {
        const targetStar = target.indexOf("*");
        const targetPrefix =
          targetStar === -1 ? target : target.slice(0, targetStar);
        return path.resolve(baseDir, targetPrefix);
      });
      patterns.push({ prefix, targets: resolvedTargets });
    }
  }

  // "references": project-references setups keep paths in each sub-config.
  if (Array.isArray(config.references)) {
    for (const ref of config.references) {
      if (typeof ref?.path === "string") {
        const refTarget = ref.path.endsWith(".json")
          ? ref.path
          : path.join(ref.path, "tsconfig.json");
        collectTsconfigPaths(
          path.resolve(baseDir, refTarget),
          patterns,
          visited,
        );
      }
    }
  }
}

/** Strips // and block comments so tsconfigs with comments parse. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}
