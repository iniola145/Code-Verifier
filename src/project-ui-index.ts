import * as fs from "fs";
import * as path from "path";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import ts from "typescript";
import { parseSourceCode } from "./parser/ast";

export interface SchemaTypeFact {
  schemaName: string;
  requiredFields: string[];
}

export interface StyleObjectFact {
  sourceFile: string;
  exportName: string;
  keys: string[];
  usedKeys: Set<string>;
}

export interface ComponentPropFact {
  required: boolean;
  callbackArity?: number;
  callbackReturnsPromise?: boolean;
  allowsNullish: boolean;
}

export interface ComponentContractFact {
  sourceFile: string;
  exportName: string;
  props: Map<string, ComponentPropFact>;
}

interface CssFact {
  filePath: string;
  classes: Set<string>;
  usedClasses: Set<string>;
  ownerFile: string;
}

interface UiModule {
  ast: t.File;
  schemaTypes: Map<string, SchemaTypeFact>;
  styleObjects: Map<string, StyleObjectFact>;
  componentContracts: Map<string, ComponentContractFact>;
  cssImports: CssFact[];
}

const SOURCE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Bounded repository index for form contracts and UI style definitions. */
export class ProjectUiIndex {
  private readonly files = new Set<string>();
  private readonly modules = new Map<string, UiModule>();
  private readonly css = new Map<string, CssFact>();
  private readonly tsConfigs: Array<{ directory: string; baseUrl: string; paths: Record<string, string[]> }> = [];
  private tailwind = false;

  static fromFiles(filePaths: string[]): ProjectUiIndex {
    const index = new ProjectUiIndex();
    filePaths.forEach((file) => index.files.add(path.resolve(file)));
    index.loadTsConfigs();
    for (const file of index.files) index.indexFile(file);
    index.linkReExports();
    index.collectUsages();
    return index;
  }

  schemaTypesForFile(ast: t.File, filePath: string): Map<string, SchemaTypeFact> {
    return this.importedFacts(ast, filePath, "schemaTypes");
  }

  styleObjectsForFile(ast: t.File, filePath: string): Map<string, StyleObjectFact> {
    return this.importedFacts(ast, filePath, "styleObjects");
  }

  componentContractsForFile(ast: t.File, filePath: string): Map<string, ComponentContractFact> {
    return this.importedFacts(ast, filePath, "componentContracts");
  }

  definedStyleObjectsForFile(filePath: string): Map<string, StyleObjectFact> {
    return this.modules.get(path.resolve(filePath))?.styleObjects ?? new Map();
  }

  cssClassesForFile(filePath: string): Set<string> {
    const direct = this.modules.get(path.resolve(filePath))?.cssImports ?? [];
    if (direct.length > 0) return new Set(direct.flatMap((fact) => [...fact.classes]));
    if (this.tailwind) return new Set();
    return new Set([...this.css.values()].flatMap((fact) => [...fact.classes]));
  }

  hasDirectCssImport(filePath: string): boolean {
    return (this.modules.get(path.resolve(filePath))?.cssImports.length ?? 0) > 0;
  }

  unusedCssClassesForFile(filePath: string): Array<{ cssFile: string; className: string }> {
    const result: Array<{ cssFile: string; className: string }> = [];
    for (const fact of this.css.values()) {
      if (fact.ownerFile !== path.resolve(filePath) || !/\.module\.css$/i.test(fact.filePath)) continue;
      for (const className of fact.classes) if (!fact.usedClasses.has(className)) result.push({ cssFile: fact.filePath, className });
    }
    return result;
  }

  private importedFacts<T extends "schemaTypes" | "styleObjects" | "componentContracts">(
    ast: t.File,
    filePath: string,
    field: T,
  ): Map<string, UiModule[T] extends Map<string, infer V> ? V : never> {
    const result = new Map<string, any>();
    for (const statement of ast.program.body) {
      if (!t.isImportDeclaration(statement)) continue;
      const resolved = this.resolveImport(filePath, statement.source.value);
      const facts = resolved ? this.modules.get(resolved)?.[field] : undefined;
      if (!facts) continue;
      for (const specifier of statement.specifiers) {
        if (t.isImportSpecifier(specifier)) {
          const imported = t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value;
          if (facts.has(imported)) result.set(specifier.local.name, facts.get(imported));
        } else if (t.isImportDefaultSpecifier(specifier) && facts.has("default")) result.set(specifier.local.name, facts.get("default"));
        else if (t.isImportNamespaceSpecifier(specifier)) for (const [name, fact] of facts) result.set(`${specifier.local.name}.${name}`, fact);
      }
    }
    return result;
  }

  private indexFile(filePath: string): void {
    try {
      const code = fs.readFileSync(filePath, "utf8");
      const { ast } = parseSourceCode(code, filePath);
      const localSchemas = collectSchemaTypes(ast);
      const localStyles = collectStyleObjects(ast, filePath);
      const localContracts = collectComponentContracts(ast, filePath);
      const schemaTypes = new Map<string, SchemaTypeFact>();
      const styleObjects = new Map<string, StyleObjectFact>();
      const componentContracts = new Map<string, ComponentContractFact>();
      for (const [exported, local] of exportBindings(ast)) {
        if (localSchemas.has(local)) schemaTypes.set(exported, localSchemas.get(local)!);
        if (localStyles.has(local)) styleObjects.set(exported, { ...localStyles.get(local)!, exportName: exported });
        if (localContracts.has(local)) componentContracts.set(exported, { ...localContracts.get(local)!, exportName: exported });
      }
      const cssImports: CssFact[] = [];
      for (const statement of ast.program.body) {
        if (!t.isImportDeclaration(statement) || !/\.css$/i.test(statement.source.value)) continue;
        const cssPath = path.resolve(path.dirname(filePath), statement.source.value);
        if (!fs.existsSync(cssPath)) continue;
        let fact = this.css.get(cssPath);
        if (!fact) {
          const cssText = fs.readFileSync(cssPath, "utf8");
          this.tailwind ||= /@tailwind|@import\s+["']tailwindcss/.test(cssText);
          fact = { filePath: cssPath, classes: extractCssClasses(cssText), usedClasses: new Set(), ownerFile: filePath };
          this.css.set(cssPath, fact);
        }
        cssImports.push(fact);
        if (statement.specifiers.length > 0) {
          const local = statement.specifiers[0].local.name;
          styleObjects.set(local, { sourceFile: cssPath, exportName: "default", keys: [...fact.classes], usedKeys: fact.usedClasses });
        }
      }
      this.modules.set(filePath, { ast, schemaTypes, styleObjects, componentContracts, cssImports });
    } catch {
      // Normal file verification reports parse/read failures.
    }
  }

  private linkReExports(): void {
    for (let pass = 0; pass < Math.min(this.modules.size + 1, 32); pass++) {
      let changed = false;
      for (const [filePath, module] of this.modules) for (const statement of module.ast.program.body) {
        if (t.isExportAllDeclaration(statement)) {
          const targetPath = this.resolveImport(filePath, statement.source.value);
          const target = targetPath ? this.modules.get(targetPath) : undefined;
          if (!target) continue;
          for (const [name, fact] of target.schemaTypes) if (!module.schemaTypes.has(name)) { module.schemaTypes.set(name, fact); changed = true; }
          for (const [name, fact] of target.styleObjects) if (!module.styleObjects.has(name)) { module.styleObjects.set(name, fact); changed = true; }
          for (const [name, fact] of target.componentContracts) if (!module.componentContracts.has(name)) { module.componentContracts.set(name, fact); changed = true; }
          continue;
        }
        if (!t.isExportNamedDeclaration(statement) || !statement.source) continue;
        const targetPath = this.resolveImport(filePath, statement.source.value);
        const target = targetPath ? this.modules.get(targetPath) : undefined;
        if (!target) continue;
        for (const specifier of statement.specifiers) {
          if (!t.isExportSpecifier(specifier)) continue;
          const imported = specifier.local.name;
          const exported = t.isIdentifier(specifier.exported) ? specifier.exported.name : specifier.exported.value;
          if (target.schemaTypes.has(imported) && !module.schemaTypes.has(exported)) { module.schemaTypes.set(exported, target.schemaTypes.get(imported)!); changed = true; }
          if (target.styleObjects.has(imported) && !module.styleObjects.has(exported)) { module.styleObjects.set(exported, target.styleObjects.get(imported)!); changed = true; }
          if (target.componentContracts.has(imported) && !module.componentContracts.has(exported)) { module.componentContracts.set(exported, target.componentContracts.get(imported)!); changed = true; }
        }
      }
      if (!changed) break;
    }
  }

  private collectUsages(): void {
    for (const [filePath, module] of this.modules) {
      const importedStyles = this.styleObjectsForFile(module.ast, filePath);
      const localStyles = this.definedStyleObjectsForFile(filePath);
      const available = new Map([...localStyles, ...importedStyles]);
      const cssFacts = thisCssFacts(module, this.css);
      traverse(module.ast, {
        MemberExpression(path) {
          if (!t.isIdentifier(path.node.object)) return;
          const fact = available.get(path.node.object.name);
          if (!fact) return;
          const key = !path.node.computed && t.isIdentifier(path.node.property) ? path.node.property.name :
            path.node.computed && t.isStringLiteral(path.node.property) ? path.node.property.value : null;
          if (key) fact.usedKeys.add(key);
          else if (path.node.computed) fact.keys.forEach((item) => fact.usedKeys.add(item));
        },
        JSXAttribute(path) {
          if (!t.isJSXIdentifier(path.node.name, { name: "className" }) || !t.isStringLiteral(path.node.value)) return;
          for (const name of path.node.value.value.split(/\s+/).filter(Boolean)) for (const css of cssFacts) css.usedClasses.add(name);
        },
        CallExpression(path) {
          const usage = classesFromDomCall(path.node);
          if (usage === null) return;
          if (usage === "dynamic") {
            for (const css of cssFacts) for (const name of css.classes) css.usedClasses.add(name);
            return;
          }
          for (const name of usage) for (const css of cssFacts) css.usedClasses.add(name);
        },
        AssignmentExpression(path) {
          if (!t.isMemberExpression(path.node.left) || !t.isIdentifier(path.node.left.property, { name: "className" })) return;
          if (!t.isStringLiteral(path.node.right)) {
            for (const css of cssFacts) for (const name of css.classes) css.usedClasses.add(name);
            return;
          }
          for (const name of path.node.right.value.split(/\s+/).filter(Boolean)) for (const css of cssFacts) css.usedClasses.add(name);
        },
      });
    }
  }

  private resolveImport(fromFile: string, specifier: string): string | null {
    if (specifier.startsWith(".")) return this.resolveCandidate(path.resolve(path.dirname(fromFile), specifier));
    const config = this.tsConfigs.find((item) => isInside(fromFile, item.directory));
    if (!config) return null;
    for (const [pattern, targets] of Object.entries(config.paths)) {
      const wildcard = matchPattern(pattern, specifier);
      if (wildcard === null) continue;
      for (const target of targets) {
        const resolved = this.resolveCandidate(path.resolve(config.baseUrl, target.includes("*") ? target.replace("*", wildcard) : target));
        if (resolved) return resolved;
      }
    }
    return this.resolveCandidate(path.resolve(config.baseUrl, specifier));
  }

  private resolveCandidate(base: string): string | null {
    for (const suffix of SOURCE_SUFFIXES) if (this.files.has(`${base}${suffix}`)) return `${base}${suffix}`;
    for (const suffix of SOURCE_SUFFIXES.slice(1)) {
      const indexed = path.join(base, `index${suffix}`);
      if (this.files.has(indexed)) return indexed;
    }
    return null;
  }

  private loadTsConfigs(): void {
    const seen = new Set<string>();
    for (const file of this.files) {
      const configPath = ts.findConfigFile(path.dirname(file), fs.existsSync, "tsconfig.json");
      if (!configPath || seen.has(configPath)) continue;
      seen.add(configPath);
      const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
      if (loaded.error || !loaded.config) continue;
      const directory = path.dirname(configPath);
      const options = loaded.config.compilerOptions ?? {};
      this.tsConfigs.push({ directory, baseUrl: path.resolve(directory, options.baseUrl ?? "."), paths: options.paths ?? {} });
    }
    this.tsConfigs.sort((a, b) => b.directory.length - a.directory.length);
  }
}

export function classesFromDomCall(node: t.CallExpression): string[] | "dynamic" | null {
  const callee = node.callee;
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property)) return null;
  const method = callee.property.name;
  if (["querySelector", "querySelectorAll", "closest", "matches"].includes(method)) {
    const selector = node.arguments[0];
    if (!t.isStringLiteral(selector)) return "dynamic";
    return [...selector.value.matchAll(/\.([_a-zA-Z]+[\w-]*)/g)].map((match) => match[1]);
  }
  if (method === "getElementsByClassName") {
    const value = node.arguments[0];
    return t.isStringLiteral(value) ? value.value.split(/\s+/).filter(Boolean) : "dynamic";
  }
  if (["add", "remove", "toggle", "replace", "contains"].includes(method) &&
    t.isMemberExpression(callee.object) && t.isIdentifier(callee.object.property, { name: "classList" })) {
    const values = node.arguments.filter(t.isStringLiteral).map((argument) => argument.value);
    return values.length === node.arguments.length ? values : "dynamic";
  }
  if (method === "setAttribute" && t.isStringLiteral(node.arguments[0], { value: "class" })) {
    const value = node.arguments[1];
    return t.isStringLiteral(value) ? value.value.split(/\s+/).filter(Boolean) : "dynamic";
  }
  return null;
}

function thisCssFacts(module: UiModule, all: Map<string, CssFact>): CssFact[] {
  return module.cssImports.length > 0 ? module.cssImports : [...all.values()];
}

function collectSchemaTypes(ast: t.File): Map<string, SchemaTypeFact> {
  const schemas = new Map<string, string[]>();
  const result = new Map<string, SchemaTypeFact>();
  for (const statement of ast.program.body) {
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (t.isVariableDeclaration(declaration)) for (const item of declaration.declarations) {
      if (!t.isIdentifier(item.id) || !t.isCallExpression(item.init) || !t.isMemberExpression(item.init.callee) ||
        !t.isIdentifier(item.init.callee.object, { name: "z" }) || !t.isIdentifier(item.init.callee.property, { name: "object" })) continue;
      const shape = item.init.arguments[0];
      if (!t.isObjectExpression(shape)) continue;
      const required: string[] = [];
      for (const property of shape.properties) {
        if (!t.isObjectProperty(property)) continue;
        const name = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
        if (!name) continue;
        const text = JSON.stringify(property.value);
        if (!/"property":\{"type":"Identifier","name":"optional"/.test(text) && !/"name":"default"/.test(text)) required.push(name);
      }
      schemas.set(item.id.name, required);
    }
    if (t.isTSTypeAliasDeclaration(declaration) && t.isTSTypeReference(declaration.typeAnnotation) &&
      t.isTSQualifiedName(declaration.typeAnnotation.typeName) && t.isIdentifier(declaration.typeAnnotation.typeName.left, { name: "z" }) &&
      t.isIdentifier(declaration.typeAnnotation.typeName.right, { name: "infer" })) {
      const parameter = declaration.typeAnnotation.typeParameters?.params[0];
      if (t.isTSTypeQuery(parameter) && t.isIdentifier(parameter.exprName) && schemas.has(parameter.exprName.name))
        result.set(declaration.id.name, { schemaName: parameter.exprName.name, requiredFields: schemas.get(parameter.exprName.name)! });
    }
  }
  return result;
}

function collectComponentContracts(ast: t.File, filePath: string): Map<string, ComponentContractFact> {
  const propTypes = new Map<string, Map<string, ComponentPropFact>>();
  const result = new Map<string, ComponentContractFact>();
  for (const statement of ast.program.body) {
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (t.isTSInterfaceDeclaration(declaration) || (t.isTSTypeAliasDeclaration(declaration) && t.isTSTypeLiteral(declaration.typeAnnotation))) {
      const name = declaration.id.name;
      const members = t.isTSInterfaceDeclaration(declaration)
        ? declaration.body.body
        : t.isTSTypeAliasDeclaration(declaration) && t.isTSTypeLiteral(declaration.typeAnnotation)
          ? declaration.typeAnnotation.members
          : [];
      const props = new Map<string, ComponentPropFact>();
      for (const member of members) {
        if (!t.isTSPropertySignature(member) || !member.typeAnnotation) continue;
        const key = t.isIdentifier(member.key) ? member.key.name : t.isStringLiteral(member.key) ? member.key.value : null;
        if (!key) continue;
        const type = member.typeAnnotation.typeAnnotation;
        const callback = t.isTSFunctionType(type) ? type : null;
        props.set(key, {
          required: !member.optional,
          callbackArity: callback?.parameters.length,
          callbackReturnsPromise: callback ? typeReturnsPromise(callback.typeAnnotation?.typeAnnotation) : undefined,
          allowsNullish: member.optional || typeAllowsNullish(type),
        });
      }
      propTypes.set(name, props);
    }
  }
  const contractForType = (type: t.TSType | null | undefined): Map<string, ComponentPropFact> | null => {
    if (!type) return null;
    if (t.isTSTypeReference(type) && t.isIdentifier(type.typeName)) return propTypes.get(type.typeName.name) ?? null;
    if (t.isTSTypeLiteral(type)) {
      const props = new Map<string, ComponentPropFact>();
      for (const member of type.members) if (t.isTSPropertySignature(member) && member.typeAnnotation) {
        const key = t.isIdentifier(member.key) ? member.key.name : t.isStringLiteral(member.key) ? member.key.value : null;
        if (!key) continue;
        const propType = member.typeAnnotation.typeAnnotation;
        const callback = t.isTSFunctionType(propType) ? propType : null;
        props.set(key, { required: !member.optional, callbackArity: callback?.parameters.length,
          callbackReturnsPromise: callback ? typeReturnsPromise(callback.typeAnnotation?.typeAnnotation) : undefined,
          allowsNullish: member.optional || typeAllowsNullish(propType) });
      }
      return props;
    }
    return null;
  };
  const record = (name: string, props: Map<string, ComponentPropFact> | null): void => {
    if (props) result.set(name, { sourceFile: filePath, exportName: name, props });
  };
  for (const statement of ast.program.body) {
    const declaration = t.isExportNamedDeclaration(statement) || t.isExportDefaultDeclaration(statement) ? statement.declaration : statement;
    if (t.isFunctionDeclaration(declaration) && declaration.id) {
      const parameter = declaration.params[0];
      const annotation = (t.isIdentifier(parameter) || t.isObjectPattern(parameter)) && t.isTSTypeAnnotation(parameter.typeAnnotation)
        ? parameter.typeAnnotation.typeAnnotation : null;
      record(declaration.id.name, contractForType(annotation));
    }
    if (t.isVariableDeclaration(declaration)) for (const item of declaration.declarations) {
      if (!t.isIdentifier(item.id) || !(t.isArrowFunctionExpression(item.init) || t.isFunctionExpression(item.init))) continue;
      let contract: Map<string, ComponentPropFact> | null = null;
      const annotation = t.isTSTypeAnnotation(item.id.typeAnnotation) ? item.id.typeAnnotation.typeAnnotation : null;
      if (t.isTSTypeReference(annotation) && t.isTSQualifiedName(annotation.typeName) &&
        t.isIdentifier(annotation.typeName.right) && ["FC", "FunctionComponent"].includes(annotation.typeName.right.name)) {
        contract = contractForType(annotation.typeParameters?.params[0]);
      }
      const parameter = item.init.params[0];
      if (!contract && (t.isIdentifier(parameter) || t.isObjectPattern(parameter)) && t.isTSTypeAnnotation(parameter.typeAnnotation))
        contract = contractForType(parameter.typeAnnotation.typeAnnotation);
      record(item.id.name, contract);
    }
  }
  // JavaScript/legacy React contracts: Component.propTypes = { value: T.isRequired }.
  traverse(ast, {
    AssignmentExpression(path) {
      if (!t.isMemberExpression(path.node.left) || !t.isIdentifier(path.node.left.object) ||
        !t.isIdentifier(path.node.left.property, { name: "propTypes" }) || !t.isObjectExpression(path.node.right)) return;
      const props = new Map<string, ComponentPropFact>();
      for (const property of path.node.right.properties) {
        if (!t.isObjectProperty(property)) continue;
        const key = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
        if (!key) continue;
        const required = t.isMemberExpression(property.value) && t.isIdentifier(property.value.property, { name: "isRequired" });
        const text = property.value.start != null && property.value.end != null ? "" : "";
        props.set(key, { required, allowsNullish: !required, callbackArity: /func/i.test(text) ? 0 : undefined });
      }
      record(path.node.left.object.name, props);
    },
  });
  return result;
}

function typeReturnsPromise(type: t.TSType | null | undefined): boolean {
  if (!type) return false;
  if (t.isTSUnionType(type)) return type.types.some(typeReturnsPromise);
  return t.isTSTypeReference(type) && t.isIdentifier(type.typeName, { name: "Promise" });
}

function typeAllowsNullish(type: t.TSType): boolean {
  return t.isTSUnionType(type) && type.types.some((item) => t.isTSNullKeyword(item) || t.isTSUndefinedKeyword(item) || t.isTSVoidKeyword(item));
}

function collectStyleObjects(ast: t.File, filePath: string): Map<string, StyleObjectFact> {
  const result = new Map<string, StyleObjectFact>();
  for (const statement of ast.program.body) {
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    for (const item of declaration.declarations) {
      if (!t.isIdentifier(item.id)) continue;
      const nativeObject = t.isCallExpression(item.init) && t.isMemberExpression(item.init.callee) && t.isIdentifier(item.init.callee.object, { name: "StyleSheet" }) &&
        t.isIdentifier(item.init.callee.property, { name: "create" }) && t.isObjectExpression(item.init.arguments[0]) ? item.init.arguments[0] : null;
      const plainObject = t.isObjectExpression(item.init) ? item.init : null;
      const isStyleMap = plainObject && plainObject.properties.length > 0 && plainObject.properties.every((property) =>
        (t.isObjectProperty(property) && (t.isObjectExpression(property.value) || t.isFunction(property.value))) || t.isObjectMethod(property));
      const object = nativeObject ?? (isStyleMap ? plainObject : null);
      if (!object || !/(?:styles?|classes)$/i.test(item.id.name)) continue;
      const keys = object.properties.flatMap((property) => t.isObjectProperty(property) || t.isObjectMethod(property)
        ? [t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : ""].filter(Boolean) : []);
      result.set(item.id.name, { sourceFile: filePath, exportName: item.id.name, keys, usedKeys: new Set() });
    }
  }
  return result;
}

function extractCssClasses(css: string): Set<string> {
  const classes = new Set<string>();
  for (const match of css.matchAll(/\.([_a-zA-Z]+[\w-]*)/g)) classes.add(match[1]);
  return classes;
}

function exportBindings(ast: t.File): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const statement of ast.program.body) {
    if (t.isExportNamedDeclaration(statement) && statement.declaration) {
      const declaration = statement.declaration;
      if (t.isVariableDeclaration(declaration)) for (const item of declaration.declarations) if (t.isIdentifier(item.id)) result.push([item.id.name, item.id.name]);
      if (t.isTSTypeAliasDeclaration(declaration)) result.push([declaration.id.name, declaration.id.name]);
      if (t.isFunctionDeclaration(declaration) && declaration.id) result.push([declaration.id.name, declaration.id.name]);
    }
    if (t.isExportNamedDeclaration(statement) && !statement.declaration && !statement.source) {
      for (const specifier of statement.specifiers) if (t.isExportSpecifier(specifier))
        result.push([t.isIdentifier(specifier.exported) ? specifier.exported.name : specifier.exported.value, specifier.local.name]);
    }
    if (t.isExportDefaultDeclaration(statement) && t.isFunctionDeclaration(statement.declaration) && statement.declaration.id)
      result.push(["default", statement.declaration.id.name]);
  }
  return result;
}

function isInside(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function matchPattern(pattern: string, value: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === value ? "" : null;
  const prefix = pattern.slice(0, star), suffix = pattern.slice(star + 1);
  return value.startsWith(prefix) && value.endsWith(suffix) ? value.slice(prefix.length, value.length - suffix.length) : null;
}
