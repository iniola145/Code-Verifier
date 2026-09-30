import * as path from "path";
import * as fs from "fs";
import * as t from "@babel/types";
import ts from "typescript";
import { parseSourceCode } from "../parser/ast";
import { buildFunctionSummaries, FunctionSummary } from "./function-summaries";

interface ModuleSummary {
  exports: Map<string, FunctionSummary>;
  behaviors: Map<string, ProjectFunctionBehavior>;
  ast: t.File;
}

export interface ProjectFunctionBehavior {
  singleFlightRefresh: boolean;
  validatesResponse: boolean;
  performsApiWrite: boolean;
}

const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

interface TsConfigResolution {
  directory: string;
  baseUrl: string;
  paths: Record<string, string[]>;
}

/**
 * A bounded project index for explicit relative ESM imports. Resolution is
 * restricted to the analyzed file set, so analysis never follows dependencies
 * or reads an unbounded tree behind the caller's back.
 */
export class ProjectSummaryIndex {
  private readonly modules = new Map<string, ModuleSummary>();
  private readonly files = new Set<string>();
  private readonly tsConfigs: TsConfigResolution[] = [];

  static fromFiles(filePaths: string[]): ProjectSummaryIndex {
    const index = new ProjectSummaryIndex();
    for (const filePath of filePaths) index.files.add(path.resolve(filePath));
    index.loadTsConfigs();
    for (const filePath of index.files) index.indexFile(filePath);
    index.composeProjectSummaries();
    return index;
  }

  summariesForFile(
    ast: t.File,
    filePath: string,
  ): Map<string, FunctionSummary> {
    const summaries = new Map<string, FunctionSummary>();
    for (const statement of ast.program.body) {
      if (!t.isImportDeclaration(statement)) continue;
      const resolved = this.resolveImport(filePath, statement.source.value);
      if (!resolved) continue;
      const module = this.modules.get(resolved);
      if (!module) continue;

      for (const specifier of statement.specifiers) {
        if (t.isImportSpecifier(specifier)) {
          const imported = t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value;
          const summary = module.exports.get(imported);
          if (summary)
            summaries.set(specifier.local.name, {
              ...summary,
              name: specifier.local.name,
            });
        } else if (t.isImportDefaultSpecifier(specifier)) {
          const summary = module.exports.get("default");
          if (summary)
            summaries.set(specifier.local.name, {
              ...summary,
              name: specifier.local.name,
            });
        } else if (t.isImportNamespaceSpecifier(specifier)) {
          for (const [exportedName, summary] of module.exports) {
            summaries.set(`${specifier.local.name}.${exportedName}`, {
              ...summary,
              name: `${specifier.local.name}.${exportedName}`,
            });
          }
        }
      }
    }
    return summaries;
  }

  behaviorsForFile(
    ast: t.File,
    filePath: string,
  ): Map<string, ProjectFunctionBehavior> {
    const behaviors = new Map<string, ProjectFunctionBehavior>();
    for (const statement of ast.program.body) {
      if (!t.isImportDeclaration(statement)) continue;
      const resolved = this.resolveImport(filePath, statement.source.value);
      const module = resolved ? this.modules.get(resolved) : undefined;
      if (!module) continue;
      for (const specifier of statement.specifiers) {
        if (t.isImportSpecifier(specifier)) {
          const imported = t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value;
          const behavior = module.behaviors.get(imported);
          if (behavior) behaviors.set(specifier.local.name, behavior);
        } else if (t.isImportDefaultSpecifier(specifier)) {
          const behavior = module.behaviors.get("default");
          if (behavior) behaviors.set(specifier.local.name, behavior);
        } else if (t.isImportNamespaceSpecifier(specifier)) {
          for (const [name, behavior] of module.behaviors)
            behaviors.set(`${specifier.local.name}.${name}`, behavior);
        }
      }
    }
    return behaviors;
  }

  private indexFile(filePath: string): void {
    try {
      const parsed = parseSourceCode(
        fs.readFileSync(filePath, "utf8"),
        filePath,
      );
      const local = buildFunctionSummaries(parsed.ast);
      const exported = new Map<string, FunctionSummary>();
      const behaviors = new Map<string, ProjectFunctionBehavior>();
      const code = fs.readFileSync(filePath, "utf8");
      const localBehaviors = collectFunctionBehaviors(parsed.ast, code);
      for (const statement of parsed.ast.program.body) {
        if (t.isExportNamedDeclaration(statement)) {
          if (statement.declaration) {
            for (const name of declarationNames(statement.declaration)) {
              const summary = local.get(name);
              if (summary) exported.set(name, summary);
              const behavior = localBehaviors.get(name);
              if (behavior) behaviors.set(name, behavior);
            }
          }
          for (const specifier of statement.specifiers) {
            if (!t.isExportSpecifier(specifier) || statement.source) continue;
            const localName = specifier.local.name;
            const exportedName = nodeName(specifier.exported);
            if (!exportedName) continue;
            const summary = local.get(localName);
            if (summary) exported.set(exportedName, summary);
            const behavior = localBehaviors.get(localName);
            if (behavior) behaviors.set(exportedName, behavior);
          }
        } else if (t.isExportDefaultDeclaration(statement)) {
          const declaration = statement.declaration;
          const name =
            t.isFunctionDeclaration(declaration) && declaration.id
              ? declaration.id.name
              : "default";
          if (local.has(name)) exported.set("default", local.get(name)!);
          const behavior = localBehaviors.get(name);
          if (behavior) behaviors.set("default", behavior);
        }
      }
      this.modules.set(filePath, {
        exports: exported,
        behaviors,
        ast: parsed.ast,
      });
    } catch {
      // The normal verifier reports parse/read failures. The summary index
      // simply withholds facts it could not prove.
    }
  }

  private linkReExports(): void {
    for (let pass = 0; pass < this.modules.size; pass++) {
      let changed = false;
      for (const [filePath, module] of this.modules) {
        for (const statement of module.ast.program.body) {
          if (t.isExportAllDeclaration(statement)) {
            const targetPath = this.resolveImport(
              filePath,
              statement.source.value,
            );
            const target = targetPath
              ? this.modules.get(targetPath)
              : undefined;
            if (!target) continue;
            for (const [exportedName, summary] of target.exports) {
              if (
                exportedName === "default" ||
                module.exports.has(exportedName)
              )
                continue;
              module.exports.set(exportedName, {
                ...summary,
                name: exportedName,
              });
              changed = true;
            }
            for (const [exportedName, behavior] of target.behaviors) {
              if (
                exportedName !== "default" &&
                !module.behaviors.has(exportedName)
              ) {
                module.behaviors.set(exportedName, behavior);
                changed = true;
              }
            }
            continue;
          }
          if (!t.isExportNamedDeclaration(statement) || !statement.source)
            continue;
          const targetPath = this.resolveImport(
            filePath,
            statement.source.value,
          );
          const target = targetPath ? this.modules.get(targetPath) : undefined;
          if (!target) continue;
          for (const specifier of statement.specifiers) {
            if (!t.isExportSpecifier(specifier)) continue;
            const importedName = specifier.local.name;
            const exportedName = nodeName(specifier.exported);
            const summary = target.exports.get(importedName);
            if (exportedName && summary && !module.exports.has(exportedName)) {
              module.exports.set(exportedName, {
                ...summary,
                name: exportedName,
              });
              changed = true;
            }
            const behavior = target.behaviors.get(importedName);
            if (
              exportedName &&
              behavior &&
              !module.behaviors.has(exportedName)
            ) {
              module.behaviors.set(exportedName, behavior);
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }
  }

  private composeProjectSummaries(): void {
    for (let pass = 0; pass < Math.min(this.modules.size + 1, 32); pass++) {
      let changed = false;
      for (const [filePath, module] of this.modules) {
        const summaries = buildFunctionSummaries(
          module.ast,
          this.summariesForFile(module.ast, filePath),
        );
        for (const [exportedName, localName] of exportBindings(module.ast)) {
          const summary = summaries.get(localName);
          if (!summary) continue;
          const next = { ...summary, name: exportedName };
          if (
            JSON.stringify(module.exports.get(exportedName)) !==
            JSON.stringify(next)
          ) {
            module.exports.set(exportedName, next);
            changed = true;
          }
        }
      }
      this.linkReExports();
      if (!changed) break;
    }
  }

  private resolveImport(fromFile: string, specifier: string): string | null {
    if (specifier.startsWith(".")) {
      return this.resolveCandidate(
        path.resolve(path.dirname(fromFile), specifier),
      );
    }
    const config = this.tsConfigs.find((candidate) =>
      isInside(fromFile, candidate.directory),
    );
    if (!config) return null;
    for (const [pattern, targets] of Object.entries(config.paths)) {
      const wildcard = matchPathPattern(pattern, specifier);
      if (wildcard === null) continue;
      for (const target of targets) {
        const candidate = target.includes("*")
          ? target.replace("*", wildcard)
          : target;
        const resolved = this.resolveCandidate(
          path.resolve(config.baseUrl, candidate),
        );
        if (resolved) return resolved;
      }
    }
    return this.resolveCandidate(path.resolve(config.baseUrl, specifier));
  }

  private resolveCandidate(base: string): string | null {
    for (const suffix of RESOLUTION_SUFFIXES) {
      const direct = `${base}${suffix}`;
      if (this.files.has(direct)) return direct;
    }
    for (const suffix of RESOLUTION_SUFFIXES.slice(1)) {
      const indexed = path.join(base, `index${suffix}`);
      if (this.files.has(indexed)) return indexed;
    }
    return null;
  }

  private loadTsConfigs(): void {
    const seen = new Set<string>();
    for (const file of this.files) {
      const configPath = ts.findConfigFile(
        path.dirname(file),
        fs.existsSync,
        "tsconfig.json",
      );
      if (!configPath || seen.has(configPath)) continue;
      seen.add(configPath);
      const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
      if (loaded.error || !loaded.config) continue;
      const directory = path.dirname(configPath);
      const options = loaded.config.compilerOptions ?? {};
      const baseUrl = path.resolve(directory, options.baseUrl ?? ".");
      this.tsConfigs.push({ directory, baseUrl, paths: options.paths ?? {} });
    }
    this.tsConfigs.sort((a, b) => b.directory.length - a.directory.length);
  }
}

function collectFunctionBehaviors(
  ast: t.File,
  code: string,
): Map<string, ProjectFunctionBehavior> {
  const result = new Map<string, ProjectFunctionBehavior>();
  const record = (name: string, node: t.Function): void => {
    const text =
      node.start != null && node.end != null
        ? code.slice(node.start, node.end)
        : "";
    result.set(name, {
      singleFlightRefresh:
        /(?:refreshPromise|isRefreshing|failedQueue|refreshQueue|subscribers|singleFlight|mutex)/i.test(
          text,
        ),
      validatesResponse: /\.(?:parse|safeParse|validate|decode)\s*\(/.test(
        text,
      ),
      performsApiWrite: /\.(?:post|put|patch|delete)\s*\(/i.test(text),
    });
  };
  for (const statement of ast.program.body) {
    const declaration =
      t.isExportNamedDeclaration(statement) ||
      t.isExportDefaultDeclaration(statement)
        ? statement.declaration
        : statement;
    if (t.isFunctionDeclaration(declaration) && declaration.id)
      record(declaration.id.name, declaration);
    if (t.isVariableDeclaration(declaration))
      for (const item of declaration.declarations) {
        if (
          t.isIdentifier(item.id) &&
          (t.isFunctionExpression(item.init) ||
            t.isArrowFunctionExpression(item.init))
        )
          record(item.id.name, item.init);
      }
  }
  return result;
}

function isInside(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function matchPathPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function declarationNames(declaration: t.Declaration): string[] {
  if (t.isFunctionDeclaration(declaration) && declaration.id)
    return [declaration.id.name];
  if (t.isVariableDeclaration(declaration)) {
    return declaration.declarations.flatMap((item) =>
      t.isIdentifier(item.id) ? [item.id.name] : [],
    );
  }
  return [];
}

function nodeName(node: t.Identifier | t.StringLiteral): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node)) return node.value;
  return null;
}

function exportBindings(ast: t.File): Array<[string, string]> {
  const bindings: Array<[string, string]> = [];
  for (const statement of ast.program.body) {
    if (t.isExportNamedDeclaration(statement) && statement.declaration) {
      for (const name of declarationNames(statement.declaration))
        bindings.push([name, name]);
    } else if (t.isExportNamedDeclaration(statement) && !statement.source) {
      for (const specifier of statement.specifiers) {
        if (t.isExportSpecifier(specifier)) {
          const exported = nodeName(specifier.exported);
          if (exported) bindings.push([exported, specifier.local.name]);
        }
      }
    } else if (t.isExportDefaultDeclaration(statement)) {
      const declaration = statement.declaration;
      const local =
        t.isFunctionDeclaration(declaration) && declaration.id
          ? declaration.id.name
          : "default";
      bindings.push(["default", local]);
    }
  }
  return bindings;
}
