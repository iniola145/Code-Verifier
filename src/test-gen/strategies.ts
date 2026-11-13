import * as path from "path";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import {
  ComponentContractFact,
  ComponentPropFact,
} from "../project-ui-index";
import { Diagnostic } from "../types/verifier";
import { StrategyContext, TestCase, TestFramework } from "./types";
import { isReactNativeProject } from "./detect-framework";

/**
 * Returns the appropriate @testing-library import for native vs web projects.
 */
function getRenderImport(isNative: boolean, extra: string[] = []): string {
  const pkg = isNative ? "@testing-library/react-native" : "@testing-library/react";
  const items = ["render", ...extra];
  return `import { ${items.join(", ")} } from '${pkg}';`;
}

/**
 * A test generation strategy interface.
 */
export interface TestStrategy {
  /** The rule IDs this strategy handles */
  handlesRules: string[];
  /** Generate test cases for a finding */
  generate(context: StrategyContext, finding: Diagnostic): TestCase[];
}

/** Information about an extracted function or component */
interface EnclosingFunctionInfo {
  name: string;
  params: string[];
  isComponent: boolean;
}

/** Extracted property definition from AST */
interface ExtractedProp {
  name: string;
  required: boolean;
  typeKind?: string;
}

/** Information about file exports */
export interface FileExports {
  defaultExportName?: string;
  namedExports: Set<string>;
}

/**
 * Inspect AST to extract file exports (default export and named exports).
 */
export function getFileExports(ast: any): FileExports {
  let defaultExportName: string | undefined;
  const namedExports = new Set<string>();

  traverse(ast, {
    ExportDefaultDeclaration(path: any) {
      const decl = path.node.declaration;
      if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) {
        defaultExportName = decl.id.name;
      } else if (t.isIdentifier(decl)) {
        defaultExportName = decl.name;
      } else {
        defaultExportName = "DefaultExport";
      }
    },
    ExportNamedDeclaration(path: any) {
      const decl = path.node.declaration;
      if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) {
        namedExports.add(decl.id.name);
      } else if (t.isVariableDeclaration(decl)) {
        for (const item of decl.declarations) {
          if (t.isIdentifier(item.id)) {
            namedExports.add(item.id.name);
          }
        }
      }
      for (const spec of path.node.specifiers) {
        if (t.isExportSpecifier(spec)) {
          const name = t.isIdentifier(spec.exported)
            ? spec.exported.name
            : (spec.exported as any).value;
          if (name) namedExports.add(name);
        }
      }
    },
  });

  return { defaultExportName, namedExports };
}

/**
 * Extract parameter names and object destructuring keys.
 */
function extractParamNames(params: any[]): string[] {
  return params.flatMap((p: any) => {
    if (t.isIdentifier(p)) return [p.name];
    if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) return [p.left.name];
    if (t.isObjectPattern(p)) {
      return p.properties.flatMap((prop: any) =>
        t.isObjectProperty(prop) && t.isIdentifier(prop.key)
          ? [prop.key.name]
          : [],
      );
    }
    return [];
  });
}

/**
 * Inspect AST to extract component props from TypeScript interfaces, type aliases, and parameter destructuring.
 */
function extractPropsFromAst(ast: any, componentName: string): ExtractedProp[] {
  const propsMap = new Map<string, ExtractedProp>();

  const possibleTypeNames = [
    `${componentName}Props`,
    `Props`,
    `${componentName}PropsType`,
  ];

  function inspectTypeMembers(members: any[]) {
    for (const member of members) {
      if (t.isTSPropertySignature(member)) {
        const name = t.isIdentifier(member.key)
          ? member.key.name
          : t.isStringLiteral(member.key)
            ? member.key.value
            : null;
        if (!name) continue;

        let typeKind = "string";
        const ann = member.typeAnnotation?.typeAnnotation;
        if (ann) {
          if (t.isTSNumberKeyword(ann)) typeKind = "number";
          else if (t.isTSBooleanKeyword(ann)) typeKind = "boolean";
          else if (t.isTSStringKeyword(ann)) typeKind = "string";
          else if (t.isTSFunctionType(ann)) typeKind = "function";
          else if (t.isTSArrayType(ann)) typeKind = "array";
          else if (t.isTSTypeLiteral(ann)) typeKind = "object";
          else if (
            t.isTSTypeReference(ann) &&
            t.isIdentifier(ann.typeName) &&
            /fn|func|callback|handler/i.test(ann.typeName.name)
          ) {
            typeKind = "function";
          }
        }

        propsMap.set(name, {
          name,
          required: !member.optional,
          typeKind,
        });
      }
    }
  }

  function inspectParams(params: any[]) {
    if (params.length === 0) return;
    const firstParam = params[0];

    // Parameter type annotation inline
    if (firstParam.typeAnnotation?.typeAnnotation) {
      const ann = firstParam.typeAnnotation.typeAnnotation;
      if (t.isTSTypeLiteral(ann)) {
        inspectTypeMembers(ann.members);
      }
    }

    // Destructured ObjectPattern properties
    if (t.isObjectPattern(firstParam)) {
      for (const prop of firstParam.properties) {
        if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
          const propName = prop.key.name;
          if (!propsMap.has(propName)) {
            const hasDefault = t.isAssignmentPattern(prop.value);
            propsMap.set(propName, {
              name: propName,
              required: !hasDefault,
              typeKind: propName.startsWith("on") ? "function" : undefined,
            });
          }
        }
      }
    }
  }

  traverse(ast, {
    TSInterfaceDeclaration(path: any) {
      if (
        possibleTypeNames.includes(path.node.id.name) ||
        path.node.id.name.toLowerCase().includes(componentName.toLowerCase())
      ) {
        inspectTypeMembers(path.node.body.body);
      }
    },
    TSTypeAliasDeclaration(path: any) {
      if (
        possibleTypeNames.includes(path.node.id.name) ||
        path.node.id.name.toLowerCase().includes(componentName.toLowerCase())
      ) {
        if (t.isTSTypeLiteral(path.node.typeAnnotation)) {
          inspectTypeMembers(path.node.typeAnnotation.members);
        }
      }
    },
    FunctionDeclaration(path: any) {
      if (path.node.id && path.node.id.name === componentName) {
        inspectParams(path.node.params);
      }
    },
    VariableDeclarator(path: any) {
      if (
        t.isIdentifier(path.node.id) &&
        path.node.id.name === componentName &&
        (t.isArrowFunctionExpression(path.node.init) ||
          t.isFunctionExpression(path.node.init))
      ) {
        inspectParams(path.node.init.params);
      }
    },
  });

  return [...propsMap.values()];
}

/**
 * Inspect AST to find function/component enclosing a given line number.
 * Uses line span to find the closest (innermost) enclosing function.
 */
function findEnclosingFunction(
  ast: any,
  targetLine: number,
): EnclosingFunctionInfo | null {
  let bestMatch: {
    node: any;
    name: string;
    params: string[];
    span: number;
    startLine: number;
  } | null = null;

  traverse(ast, {
    "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassMethod"(
      path: any,
    ) {
      const loc = path.node.loc;
      if (!loc) return;
      if (loc.start.line <= targetLine && loc.end.line >= targetLine) {
        let name = "anonymous";
        if (t.isFunctionDeclaration(path.node) && path.node.id) {
          name = path.node.id.name;
        } else if (
          t.isVariableDeclarator(path.parent) &&
          t.isIdentifier(path.parent.id)
        ) {
          name = path.parent.id.name;
        } else if (
          t.isClassMethod(path.node) &&
          t.isIdentifier(path.node.key)
        ) {
          name = path.node.key.name;
        } else if (
          t.isExportDefaultDeclaration(path.parent) ||
          t.isExportDefaultDeclaration(path.parentPath?.parent)
        ) {
          name = "DefaultExport";
        }

        const params = extractParamNames(path.node.params);
        const span = loc.end.line - loc.start.line;

        // Choose the tightest span enclosing the target line
        if (!bestMatch || span < bestMatch.span) {
          bestMatch = { node: path.node, name, params, span, startLine: loc.start.line };
        }
      }
    },
  });

  const foundMatch = bestMatch as {
    node: any;
    name: string;
    params: string[];
    span: number;
    startLine: number;
  } | null;

  if (!foundMatch) return null;

  const isComponent =
    /^[A-Z]/.test(foundMatch.name) ||
    foundMatch.name.endsWith("Screen") ||
    foundMatch.name.endsWith("View") ||
    foundMatch.name.endsWith("Component");

  return {
    name: foundMatch.name,
    params: foundMatch.params,
    isComponent,
  };
}

/**
 * Find default, named exported, or unexported top-level component in AST.
 */
function findMainComponent(ast: any): EnclosingFunctionInfo | null {
  let main: EnclosingFunctionInfo | null = null;

  traverse(ast, {
    ExportDefaultDeclaration(path: any) {
      const decl = path.node.declaration;
      let name = "DefaultComponent";
      let params: string[] = [];

      if (t.isFunctionDeclaration(decl)) {
        name = decl.id ? decl.id.name : "DefaultComponent";
        params = extractParamNames(decl.params);
      } else if (t.isIdentifier(decl)) {
        name = decl.name;
      }

      main = {
        name,
        params,
        isComponent: /^[A-Z]/.test(name) || name.includes("Screen"),
      };
    },
    ExportNamedDeclaration(path: any) {
      if (main) return;
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id && /^[A-Z]/.test(decl.id.name)) {
        main = {
          name: decl.id.name,
          params: extractParamNames(decl.params),
          isComponent: true,
        };
      } else if (t.isVariableDeclaration(decl)) {
        for (const item of decl.declarations) {
          if (t.isIdentifier(item.id) && /^[A-Z]/.test(item.id.name)) {
            const params =
              t.isArrowFunctionExpression(item.init) ||
              t.isFunctionExpression(item.init)
                ? extractParamNames(item.init.params)
                : [];
            main = {
              name: item.id.name,
              params,
              isComponent: true,
            };
            break;
          }
        }
      }
    },
  });

  if (main) return main;

  // Fallback: search for unexported top-level component declaration
  traverse(ast, {
    FunctionDeclaration(path: any) {
      if (main) return;
      if (path.node.id && /^[A-Z]/.test(path.node.id.name)) {
        main = {
          name: path.node.id.name,
          params: extractParamNames(path.node.params),
          isComponent: true,
        };
      }
    },
    VariableDeclarator(path: any) {
      if (main) return;
      if (
        t.isIdentifier(path.node.id) &&
        /^[A-Z]/.test(path.node.id.name) &&
        (t.isArrowFunctionExpression(path.node.init) ||
          t.isFunctionExpression(path.node.init))
      ) {
        const init = path.node.init as any;
        main = {
          name: path.node.id.name,
          params: extractParamNames(init.params),
          isComponent: true,
        };
      }
    },
  });

  return main;
}

/**
 * Resolve the test target: prefers exported symbols or top-level components over unexported inner closures.
 */
function findTarget(
  ast: any,
  targetLine: number,
  baseName: string,
): EnclosingFunctionInfo {
  const fileExports = getFileExports(ast);
  const enclosing = findEnclosingFunction(ast, targetLine);
  const mainComp = findMainComponent(ast);

  if (enclosing) {
    if (
      fileExports.namedExports.has(enclosing.name) ||
      fileExports.defaultExportName === enclosing.name ||
      enclosing.isComponent
    ) {
      return enclosing;
    }
  }

  if (mainComp) {
    return mainComp;
  }

  return {
    name: fileExports.defaultExportName || baseName,
    params: [],
    isComponent: true,
  };
}

/**
 * Generate default value for a component prop.
 */
function generateDefaultPropValue(
  propName: string,
  fact?: ComponentPropFact,
  framework: TestFramework = "jest",
  typeKind?: string,
  isNative = true,
): string {
  const fnKeyword = framework === "jest" ? "jest.fn()" : "vi.fn()";

  if (
    typeKind === "function" ||
    propName.startsWith("on") ||
    propName.startsWith("handle") ||
    fact?.callbackArity !== undefined ||
    fact?.callbackReturnsVoid ||
    fact?.callbackReturnsPromise
  ) {
    return fnKeyword;
  }

  if (typeKind === "number") return "1";
  if (typeKind === "boolean") return "true";
  if (typeKind === "array") return "[]";
  if (typeKind === "object") return "{}";

  const lower = propName.toLowerCase();
  if (lower.endsWith("id")) return `'test-${propName}'`;
  if (lower.includes("name") || lower.includes("title") || lower.includes("label"))
    return `'Test ${propName}'`;
  if (lower.includes("count") || lower.includes("amount") || lower.includes("index") || lower.includes("age"))
    return `1`;
  if (
    lower.startsWith("is") ||
    lower.startsWith("has") ||
    lower.includes("enabled") ||
    lower.includes("visible") ||
    lower.includes("active")
  )
    return `true`;
  if (lower === "user" || lower === "item" || lower === "data")
    return `{ id: 'test-id', name: 'Test' }`;
  if (lower === "route") return `{ params: {} }`;
  if (lower === "navigation")
    return `{ navigate: ${fnKeyword}, goBack: ${fnKeyword} }`;
  if (lower === "style") return `{}`;
  if (lower === "children") return isNative ? `<Text>Test Child</Text>` : `<div>Test Child</div>`;

  return `'test-${propName}'`;
}

/**
 * Resolve required props string for a component using contracts, AST, and invariants.
 */
export function getRequiredPropsString(
  componentName: string,
  context: StrategyContext,
  finding?: Diagnostic,
  excludeProps: string[] = [],
): string {
  const { framework, contracts, ast } = context;
  const isNative = isReactNativeProject(context.projectRoot, context.code);
  const pairs: string[] = [];
  const handled = new Set<string>(excludeProps);

  // 1. From contracts
  if (contracts && Array.isArray(contracts)) {
    const contract = contracts.find(
      (c) =>
        c.exportName === componentName ||
        c.sourceFile.includes(componentName),
    );
    if (contract?.props) {
      for (const [propName, fact] of contract.props.entries()) {
        if (fact.required) {
          handled.add(propName);
          const val = generateDefaultPropValue(propName, fact, framework, undefined, isNative);
          pairs.push(`${propName}={${val}}`);
        }
      }
    }
  }

  // 2. From abstract invariants (e.g. finding.abstractInvariants["2.required"])
  if (finding?.abstractInvariants?.["2.required"]) {
    const propNames = finding.abstractInvariants["2.required"]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of propNames) {
      if (!handled.has(p)) {
        handled.add(p);
        const val = generateDefaultPropValue(p, undefined, framework, undefined, isNative);
        pairs.push(`${p}={${val}}`);
      }
    }
  }

  // 3. From AST inspection
  if (ast) {
    const extracted = extractPropsFromAst(ast, componentName);
    for (const prop of extracted) {
      if (prop.required && !handled.has(prop.name)) {
        handled.add(prop.name);
        const val = generateDefaultPropValue(
          prop.name,
          undefined,
          framework,
          prop.typeKind,
          isNative,
        );
        pairs.push(`${prop.name}={${val}}`);
      }
    }
  }

  return pairs.join(" ");
}

/**
 * Relative import statement for the source file.
 */
export function sourceImportStatement(
  sourceFile: string,
  importedNames: string[],
  hasDefault = false,
  fileExports?: FileExports,
): string {
  const baseName = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
  const relPath = `./${baseName}`;

  const validNamed = importedNames.filter((n) => {
    if (fileExports && fileExports.namedExports.has(n)) return true;
    if (n === baseName) return false;
    if (fileExports && fileExports.defaultExportName === n) return false;
    if (fileExports && !fileExports.namedExports.has(n)) return false;
    return true;
  });

  const isDefault =
    hasDefault ||
    (Boolean(fileExports?.defaultExportName) &&
      !importedNames.some((n) => fileExports?.namedExports.has(n)));

  if (isDefault && validNamed.length > 0) {
    return `import ${baseName}, { ${validNamed.join(", ")} } from '${relPath}';`;
  }
  if (isDefault) {
    return `import ${baseName} from '${relPath}';`;
  }
  if (validNamed.length > 0) {
    return `import { ${validNamed.join(", ")} } from '${relPath}';`;
  }
  return `import ${baseName} from '${relPath}';`;
}

// =========================================================================
// Strategy 1: Nullability Strategy (AI-NULL-001, LOGIC-004)
// =========================================================================
export const NullabilityStrategy: TestStrategy = {
  handlesRules: ["AI-NULL-001", "LOGIC-004"],

  generate(context: StrategyContext, finding: Diagnostic): TestCase[] {
    const { framework, ast, sourceFile } = context;
    const testCases: TestCase[] = [];
    const baseName = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");

    const line = finding.loc.start.line;
    const fileExports = getFileExports(ast);
    const funcInfo = findTarget(ast, line, baseName);

    const targetName =
      funcInfo.name !== "anonymous" && funcInfo.name !== "DefaultExport"
        ? funcInfo.name
        : (fileExports.defaultExportName || baseName);

    const isDefault =
      fileExports.defaultExportName === targetName ||
      !fileExports.namedExports.has(targetName);

    const isNative = isReactNativeProject(context.projectRoot, context.code);
    const testingImports = [
      `import React from 'react';`,
      getRenderImport(isNative),
      sourceImportStatement(sourceFile, [targetName], isDefault, fileExports),
    ];

    if (funcInfo.isComponent) {
      const reqProps = getRequiredPropsString(targetName, context, finding);
      const propsAttr = reqProps ? ` ${reqProps}` : "";
      const renderAssertion = isNative
        ? `const { toJSON } = render(<${targetName}${propsAttr} />);\n    expect(toJSON()).toBeDefined();`
        : `const { container } = render(<${targetName}${propsAttr} />);\n    expect(container).toBeDefined();`;

      testCases.push({
        id: `null-comp-${targetName}-${finding.ruleId}`,
        description: `should safely handle null/undefined states in ${targetName}`,
        framework,
        body: `  it('should handle null or undefined input safely in ${targetName}', () => {\n    // Covers ${finding.ruleId} at line ${line}\n    ${renderAssertion}\n  });`,
        imports: testingImports,
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.85,
      });

      // If component has props, test with explicit null props
      if (funcInfo.params.length > 0) {
        const nullProps = funcInfo.params.map((p) => `${p}={null}`).join(" ");
        const reqPropsForNull = getRequiredPropsString(
          targetName,
          context,
          finding,
          funcInfo.params,
        );
        const propsAttrForNull = reqPropsForNull ? ` ${reqPropsForNull}` : "";

        testCases.push({
          id: `null-props-${targetName}-${finding.ruleId}`,
          description: `should not crash when nullable props are null in ${targetName}`,
          framework,
          body: `  it('should not crash when nullable props are null in ${targetName}', () => {\n    // Covers ${finding.ruleId}\n    const { toJSON } = render(<${targetName}${propsAttrForNull} ${nullProps} />);\n    expect(toJSON()).toBeDefined();\n  });`,
          imports: testingImports,
          mocks: [],
          sourceFile,
          coversRules: [finding.ruleId],
          confidence: 0.8,
        });
      }
    } else {
      // Standard function
      const paramArgs =
        funcInfo.params.length > 0
          ? funcInfo.params.map(() => "null").join(", ")
          : "null";

      testCases.push({
        id: `null-func-${targetName}-${finding.ruleId}`,
        description: `should handle null argument in ${targetName}`,
        framework,
        body: `  it('should handle null argument in ${targetName}', () => {\n    // Covers ${finding.ruleId} at line ${line}\n    expect(() => {\n      const result = (${targetName} as any)(${paramArgs});\n      expect(result).toBeDefined();\n    }).not.toThrow();\n  });`,
        imports: [
          sourceImportStatement(
            sourceFile,
            [targetName],
            isDefault,
            fileExports,
          ),
        ],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.8,
      });
    }

    return testCases;
  },
};

// =========================================================================
// Strategy 2: Taint Flow Strategy (AI-TAINT-001, RN-SEC-001, RN-SEC-002, SEC-006)
// =========================================================================
export const TaintFlowStrategy: TestStrategy = {
  handlesRules: ["AI-TAINT-001", "RN-SEC-001", "RN-SEC-002", "SEC-006"],

  generate(context: StrategyContext, finding: Diagnostic): TestCase[] {
    const { framework, sourceFile, ast } = context;
    const testCases: TestCase[] = [];
    const baseName = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");

    const fileExports = getFileExports(ast);
    const comp = findTarget(ast, finding.loc.start.line, baseName);
    const targetName =
      comp.name !== "anonymous" && comp.name !== "DefaultExport"
        ? comp.name
        : (fileExports.defaultExportName || baseName);

    const isDefault =
      fileExports.defaultExportName === targetName ||
      !fileExports.namedExports.has(targetName);

    const reqProps = getRequiredPropsString(targetName, context, finding, [
      "route",
    ]);
    const propsAttr = reqProps ? ` ${reqProps}` : "";

    const isNative = isReactNativeProject(context.projectRoot, context.code);

    if (finding.ruleId === "RN-SEC-001" || finding.ruleId === "SEC-006") {
      testCases.push({
        id: `taint-sec-${finding.ruleId}`,
        description: `should not persist sensitive tokens in unencrypted storage (${finding.ruleId})`,
        framework,
        body: `  it('should not persist sensitive credentials in unencrypted storage', async () => {\n    // Covers ${finding.ruleId}\n    render(<${targetName}${propsAttr} route={{ params: { token: 'secret-token-123' } }} />);\n    await waitFor(() => {\n      expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(\n        expect.stringMatching(/token|secret|auth|jwt/i),\n        expect.anything()\n      );\n    });\n  });`,
        imports: [
          `import React from 'react';`,
          getRenderImport(isNative, ['waitFor']),
          `import AsyncStorage from '@react-native-async-storage/async-storage';`,
          sourceImportStatement(
            sourceFile,
            [targetName],
            isDefault,
            fileExports,
          ),
        ],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.85,
      });
    } else {
      // AI-TAINT-001 or RN-SEC-002: Taint into WebView or dangerous sink
      const renderAssertion = isNative
        ? `const { toJSON } = render(<${targetName}${propsAttr} route={route} />);\n    expect(toJSON()).toBeDefined();\n    // Verifies untrusted script tags do not flow unsanitized into the rendered sink\n    const serialized = JSON.stringify(toJSON());\n    expect(serialized).not.toContain('<script>alert(1)</script>');`
        : `const { container } = render(<${targetName}${propsAttr} route={route} />);\n    expect(container).toBeDefined();\n    // Verifies untrusted script tags do not flow unsanitized into the rendered sink\n    const serialized = container.innerHTML;\n    expect(serialized).not.toContain('<script>alert(1)</script>');`;

      testCases.push({
        id: `taint-sink-${finding.ruleId}`,
        description: `should sanitize untrusted deep link or route parameters before rendering sink (${finding.ruleId})`,
        framework,
        body: `  it('should sanitize untrusted input before rendering sink', async () => {\n    // Covers ${finding.ruleId}\n    const untrustedPayload = '<script>alert(1)</script>';\n    const route = { params: { untrustedHtml: untrustedPayload, query: untrustedPayload } };\n    ${renderAssertion}\n  });`,
        imports: [
          `import React from 'react';`,
          getRenderImport(isNative),
          sourceImportStatement(
            sourceFile,
            [targetName],
            isDefault,
            fileExports,
          ),
        ],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.85,
      });
    }

    return testCases;
  },
};

// =========================================================================
// Strategy 3: Component Contract Strategy (COMP-001, COMP-003)
// =========================================================================
export const ComponentContractStrategy: TestStrategy = {
  handlesRules: ["COMP-001", "COMP-003"],

  generate(context: StrategyContext, finding: Diagnostic): TestCase[] {
    const { framework, sourceFile, ast } = context;
    const testCases: TestCase[] = [];

    // Extract component name from message e.g. "UserCard is missing required prop(s): title"
    const match = finding.message.match(/^([A-Za-z0-9_]+) is missing required prop/);
    const componentName = match
      ? match[1]
      : finding.abstractInvariants?.["1.contract"]
        ? finding.abstractInvariants["1.contract"].split(" exports ")[1]
        : undefined;

    const fileExports = getFileExports(ast);
    const targetComp = componentName || "TargetComponent";
    const renderedProps = getRequiredPropsString(targetComp, context, finding);
    const propsAttr = renderedProps ? ` ${renderedProps}` : "";

    const isDefault =
      fileExports.defaultExportName === targetComp ||
      !fileExports.namedExports.has(targetComp);

    const isNative = isReactNativeProject(context.projectRoot, context.code);
    const renderAssertion = isNative
      ? `const { toJSON } = render(<${targetComp}${propsAttr} />);\n    expect(toJSON()).toBeDefined();`
      : `const { container } = render(<${targetComp}${propsAttr} />);\n    expect(container).toBeDefined();`;

    testCases.push({
      id: `contract-render-${targetComp}-${finding.ruleId}`,
      description: `should render ${targetComp} with all required contract props`,
      framework,
      body: `  it('should render ${targetComp} with all required props satisfied', () => {\n    // Covers ${finding.ruleId}\n    ${renderAssertion}\n  });`,
      imports: [
        `import React from 'react';`,
        getRenderImport(isNative),
        sourceImportStatement(sourceFile, [targetComp], isDefault, fileExports),
      ],
      mocks: [],
      sourceFile,
      coversRules: [finding.ruleId],
      confidence: 0.9,
    });

    return testCases;
  },
};

// =========================================================================
// Strategy 4: Race Condition Strategy (RACE-001 through RACE-010)
// =========================================================================
export const RaceConditionStrategy: TestStrategy = {
  handlesRules: [
    "RACE-001",
    "RACE-002",
    "RACE-003",
    "RACE-004",
    "RACE-005",
    "RACE-006",
    "RACE-007",
    "RACE-008",
    "RACE-009",
    "RACE-010",
  ],

  generate(context: StrategyContext, finding: Diagnostic): TestCase[] {
    const { framework, sourceFile, ast } = context;
    const testCases: TestCase[] = [];
    const baseName = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");

    const line = finding.loc.start.line;
    const fileExports = getFileExports(ast);
    const funcInfo = findTarget(ast, line, baseName);

    const targetName =
      funcInfo.name !== "anonymous" && funcInfo.name !== "DefaultExport"
        ? funcInfo.name
        : (fileExports.defaultExportName || baseName);

    const isDefault =
      fileExports.defaultExportName === targetName ||
      !fileExports.namedExports.has(targetName);

    const isNative = isReactNativeProject(context.projectRoot, context.code);

    if (funcInfo.isComponent) {
      const reqProps = getRequiredPropsString(targetName, context, finding, ["id"]);
      const propsAttr = reqProps ? ` ${reqProps}` : "";

      testCases.push({
        id: `race-${targetName}-${finding.ruleId}`,
        description: `should handle concurrent async operations without state collisions in ${targetName} (${finding.ruleId})`,
        framework,
        body: `  it('should handle concurrent updates safely in ${targetName} (${finding.ruleId})', async () => {\n    // Covers ${finding.ruleId} at line ${line}\n    const { rerender, queryByText } = render(<${targetName}${propsAttr} id="request-1" />);\n    // Rapid successive update before initial async request completes to simulate race condition\n    rerender(<${targetName}${propsAttr} id="request-2" />);\n    await waitFor(() => {\n      expect(queryByText('request-1')).toBeNull();\n    });\n  });`,
        imports: [
          `import React from 'react';`,
          getRenderImport(isNative, ['waitFor']),
          sourceImportStatement(
            sourceFile,
            [targetName],
            isDefault,
            fileExports,
          ),
        ],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.85,
      });
    } else {
      testCases.push({
        id: `race-${targetName}-${finding.ruleId}`,
        description: `should resolve concurrent invocations safely in ${targetName} (${finding.ruleId})`,
        framework,
        body: `  it('should handle concurrent invocations safely in ${targetName} (${finding.ruleId})', async () => {\n    // Covers ${finding.ruleId} at line ${line}\n    const op1 = Promise.resolve().then(() => (${targetName} as any)());\n    const op2 = Promise.resolve().then(() => (${targetName} as any)());\n    await expect(Promise.all([op1, op2])).resolves.toBeDefined();\n  });`,
        imports: [
          sourceImportStatement(
            sourceFile,
            [targetName],
            isDefault,
            fileExports,
          ),
        ],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.8,
      });
    }

    return testCases;
  },
};

// =========================================================================
// Strategy 5: Async Pattern Strategy (ASYNC-001, ASYNC-002, TYPE-001, SERVICE-001)
// =========================================================================
export const AsyncPatternStrategy: TestStrategy = {
  handlesRules: ["ASYNC-001", "ASYNC-002", "TYPE-001", "SERVICE-001"],

  generate(context: StrategyContext, finding: Diagnostic): TestCase[] {
    const { framework, sourceFile, ast } = context;
    const testCases: TestCase[] = [];
    const baseName = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");

    const line = finding.loc.start.line;
    const fileExports = getFileExports(ast);
    const funcInfo = findTarget(ast, line, baseName);

    const targetName =
      funcInfo.name !== "anonymous" && funcInfo.name !== "DefaultExport"
        ? funcInfo.name
        : (fileExports.defaultExportName || baseName);

    const isDefault =
      fileExports.defaultExportName === targetName ||
      !fileExports.namedExports.has(targetName);

    const isNative = isReactNativeProject(context.projectRoot, context.code);

    if (funcInfo.isComponent) {
      const reqProps = getRequiredPropsString(targetName, context, finding, ["route"]);
      const propsAttr = reqProps ? ` ${reqProps}` : "";
      const renderAssertion = isNative
        ? `const { toJSON, queryByText } = render(<${targetName}${propsAttr} route={errorRoute} />);\n    await waitFor(() => {\n      expect(toJSON()).toBeDefined();\n      expect(queryByText(/fatal error/i)).toBeNull();\n    });`
        : `const { container, queryByText } = render(<${targetName}${propsAttr} route={errorRoute} />);\n    await waitFor(() => {\n      expect(container).toBeDefined();\n      expect(queryByText(/fatal error/i)).toBeNull();\n    });`;

      testCases.push({
        id: `async-${targetName}-${finding.ruleId}`,
        description: `should handle async rejection and errors gracefully in ${targetName} (${finding.ruleId})`,
        framework,
        body: `  it('should handle async error pathways without unhandled rejection in ${targetName} (${finding.ruleId})', async () => {\n    // Covers ${finding.ruleId} at line ${line}\n    const errorRoute = { params: { error: 'Network failure', shouldFail: true } };\n    ${renderAssertion}\n  });`,
        imports: [
          `import React from 'react';`,
          getRenderImport(isNative, ['waitFor']),
          sourceImportStatement(
            sourceFile,
            [targetName],
            isDefault,
            fileExports,
          ),
        ],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.85,
      });
    } else {
      testCases.push({
        id: `async-${targetName}-${finding.ruleId}`,
        description: `should handle async error pathways gracefully in ${targetName} (${finding.ruleId})`,
        framework,
        body: `  it('should handle async error pathways gracefully in ${targetName} (${finding.ruleId})', async () => {\n    // Covers ${finding.ruleId} at line ${line}\n    await expect(async () => {\n      try {\n        await (${targetName} as any)();\n      } catch (err) {\n        // Expected handled error pathway\n      }\n    }).not.toThrow();\n  });`,
        imports: [
          sourceImportStatement(
            sourceFile,
            [targetName],
            isDefault,
            fileExports,
          ),
        ],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.8,
      });
    }

    return testCases;
  },
};

/**
 * Extract literal options passed to axios.create or similar factory from the AST.
 */
function extractAxiosCreateOptions(ast: any): {
  withCredentials?: boolean;
  headers?: Record<string, string>;
} {
  const result: { withCredentials?: boolean; headers?: Record<string, string> } =
    {};
  traverse(ast, {
    CallExpression(p: any) {
      const callee = p.node.callee;
      if (
        (t.isMemberExpression(callee) &&
          t.isIdentifier(callee.property, { name: "create" })) ||
        t.isIdentifier(callee, { name: "create" })
      ) {
        const arg = p.node.arguments[0];
        if (t.isObjectExpression(arg)) {
          for (const prop of arg.properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
              if (
                prop.key.name === "withCredentials" &&
                t.isBooleanLiteral(prop.value)
              ) {
                result.withCredentials = prop.value.value;
              }
              if (
                prop.key.name === "headers" &&
                t.isObjectExpression(prop.value)
              ) {
                result.headers = {};
                for (const hProp of prop.value.properties) {
                  if (t.isObjectProperty(hProp)) {
                    const k = t.isIdentifier(hProp.key)
                      ? hProp.key.name
                      : t.isStringLiteral(hProp.key)
                        ? hProp.key.value
                        : null;
                    const v = t.isStringLiteral(hProp.value)
                      ? hProp.value.value
                      : null;
                    if (k && v) {
                      result.headers[k] = v;
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
  });
  return result;
}

/**
 * Extract string literals checked by .includes() in the AST.
 */
function extractIncludesStrings(ast: any): string[] {
  const strings: string[] = [];
  traverse(ast, {
    CallExpression(p: any) {
      const callee = p.node.callee;
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property, { name: "includes" })
      ) {
        const arg = p.node.arguments[0];
        if (t.isStringLiteral(arg)) {
          strings.push(arg.value);
        }
      }
    },
  });
  return [...new Set(strings)];
}

// =========================================================================
// Strategy 6: Service / API Client Strategy (SERVICE-001, SERVICE-002, SERVICE-003)
// =========================================================================
export const ServiceClientStrategy: TestStrategy = {
  handlesRules: ["SERVICE-001", "SERVICE-002", "SERVICE-003"],

  generate(context: StrategyContext, finding: Diagnostic): TestCase[] {
    const { framework, sourceFile, ast } = context;
    const testCases: TestCase[] = [];
    const baseName = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
    const fileExports = getFileExports(ast);
    const line = finding.loc.start.line;
    const fnKeyword = framework === "vitest" ? "vi.fn()" : "jest.fn()";

    // Find exported client instance or functions
    const clientCandidates = ["apiClient", "client", "api", "default"];
    const foundClient =
      clientCandidates.find(
        (name) =>
          fileExports.namedExports.has(name) ||
          (name === "default" && fileExports.defaultExportName),
      ) || baseName;

    const hasSetOnUnauth = fileExports.namedExports.has("setOnUnauthenticated");

    const isDefault = foundClient === "default";
    const targetName = isDefault
      ? fileExports.defaultExportName || "apiClient"
      : foundClient;
    const namedToImport = hasSetOnUnauth
      ? [targetName, "setOnUnauthenticated"]
      : [targetName];

    const sourceImport = sourceImportStatement(
      sourceFile,
      namedToImport,
      isDefault,
      fileExports,
    );

    // 1. Inspect AST for actual production options and string constants
    const createOptions = extractAxiosCreateOptions(ast);
    const authEndpoints = extractIncludesStrings(ast);

    if (finding.ruleId === "SERVICE-003") {
      // Configuration & Call-site Assertion
      const configAssertions: string[] = [
        `    expect(${targetName}).toBeDefined();`,
        `    expect(${targetName}.defaults).toBeDefined();`,
      ];
      if (createOptions.withCredentials !== undefined) {
        configAssertions.push(
          `    expect(${targetName}.defaults.withCredentials).toBe(${createOptions.withCredentials});`,
        );
      }
      if (createOptions.headers && Object.keys(createOptions.headers).length > 0) {
        configAssertions.push(
          `    expect(${targetName}.defaults.headers).toEqual(expect.objectContaining(${JSON.stringify(createOptions.headers)}));`,
        );
      }

      testCases.push({
        id: `service-config-${targetName}`,
        description: `should verify client initialization and production configuration for ${targetName}`,
        framework,
        body: `  it('should verify client initialization and production configuration for ${targetName}', () => {\n${configAssertions.join("\n")}\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.95,
      });

      // TDR Defect Contract Test
      testCases.push({
        id: `service-timeout-defect-${targetName}`,
        description: `should enforce a bounded request timeout on ${targetName} (${finding.ruleId})`,
        framework,
        body: `  it('should enforce a bounded request timeout on ${targetName} (${finding.ruleId})', () => {\n    // Covers ${finding.ruleId} at line ${line}\n    // Central client must specify a positive timeout to prevent unbounded hanging\n    const timeout = ${targetName}.defaults?.timeout;\n    expect(typeof timeout === 'number' && timeout > 0).toBe(true);\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.9,
      });

      if (hasSetOnUnauth) {
        // Interceptor 401 Protected Route
        testCases.push({
          id: `service-interceptor-401-${targetName}`,
          description: `should trigger onUnauthenticated on 401 response for protected endpoints`,
          framework,
          body: `  it('should trigger onUnauthenticated callback on 401 for protected endpoints', async () => {\n    const unauthHandler = ${fnKeyword};\n    setOnUnauthenticated(unauthHandler);\n\n    const handlers = ${targetName}.interceptors?.response?.handlers || [];\n    const errorHandler = handlers[0]?.rejected;\n    expect(typeof errorHandler).toBe('function');\n\n    const error = {\n      config: { url: '/api/v1/protected-resource' },\n      response: { status: 401 },\n    };\n    await expect(errorHandler(error)).rejects.toEqual(error);\n    expect(unauthHandler).toHaveBeenCalledTimes(1);\n  });`,
          imports: [sourceImport],
          mocks: [],
          sourceFile,
          coversRules: [finding.ruleId],
          confidence: 0.95,
        });

        // Interceptor 401 Auth Routes Bypass
        const endpointsToTest =
          authEndpoints.length > 0
            ? authEndpoints
            : ["/auth/login", "/auth/me", "/auth/logout"];

        testCases.push({
          id: `service-interceptor-auth-401-${targetName}`,
          description: `should bypass onUnauthenticated callback on 401 for auth endpoints`,
          framework,
          body: `  it.each(${JSON.stringify(endpointsToTest)})('should bypass onUnauthenticated callback on 401 for auth endpoint %s', async (url) => {\n    const unauthHandler = ${fnKeyword};\n    setOnUnauthenticated(unauthHandler);\n\n    const handlers = ${targetName}.interceptors?.response?.handlers || [];\n    const errorHandler = handlers[0]?.rejected;\n    expect(typeof errorHandler).toBe('function');\n\n    const error = {\n      config: { url },\n      response: { status: 401 },\n    };\n    await expect(errorHandler(error)).rejects.toEqual(error);\n    expect(unauthHandler).not.toHaveBeenCalled();\n  });`,
          imports: [sourceImport],
          mocks: [],
          sourceFile,
          coversRules: [finding.ruleId],
          confidence: 0.95,
        });

        // Non-401 Negative Tests
        testCases.push({
          id: `service-interceptor-non401-${targetName}`,
          description: `should NOT trigger onUnauthenticated callback on non-401 HTTP errors`,
          framework,
          body: `  it.each([400, 403, 404, 500, 502])('should NOT trigger onUnauthenticated on HTTP %i error', async (status) => {\n    const unauthHandler = ${fnKeyword};\n    setOnUnauthenticated(unauthHandler);\n\n    const handlers = ${targetName}.interceptors?.response?.handlers || [];\n    const errorHandler = handlers[0]?.rejected;\n    expect(typeof errorHandler).toBe('function');\n\n    const error = {\n      config: { url: '/api/v1/protected-resource' },\n      response: { status },\n    };\n    await expect(errorHandler(error)).rejects.toEqual(error);\n    expect(unauthHandler).not.toHaveBeenCalled();\n  });`,
          imports: [sourceImport],
          mocks: [],
          sourceFile,
          coversRules: [finding.ruleId],
          confidence: 0.9,
        });

        // Network Drop / Undefined Response
        testCases.push({
          id: `service-interceptor-network-drop-${targetName}`,
          description: `should handle network drops gracefully when error.response is undefined`,
          framework,
          body: `  it('should handle network drops gracefully when error.response is undefined', async () => {\n    const unauthHandler = ${fnKeyword};\n    setOnUnauthenticated(unauthHandler);\n\n    const handlers = ${targetName}.interceptors?.response?.handlers || [];\n    const errorHandler = handlers[0]?.rejected;\n    expect(typeof errorHandler).toBe('function');\n\n    const networkError = {\n      config: { url: '/api/v1/protected-resource' },\n      message: 'Network Error',\n    };\n    await expect(errorHandler(networkError)).rejects.toEqual(networkError);\n    expect(unauthHandler).not.toHaveBeenCalled();\n  });`,
          imports: [sourceImport],
          mocks: [],
          sourceFile,
          coversRules: [finding.ruleId],
          confidence: 0.9,
        });

        // Unset Callback Safety
        testCases.push({
          id: `service-interceptor-unset-callback-${targetName}`,
          description: `should not throw when onUnauthenticated callback is null`,
          framework,
          body: `  it('should not throw when onUnauthenticated callback is not configured (null)', async () => {\n    setOnUnauthenticated(null);\n\n    const handlers = ${targetName}.interceptors?.response?.handlers || [];\n    const errorHandler = handlers[0]?.rejected;\n    expect(typeof errorHandler).toBe('function');\n\n    const error = {\n      config: { url: '/api/v1/protected-resource' },\n      response: { status: 401 },\n    };\n    await expect(errorHandler(error)).rejects.toEqual(error);\n  });`,
          imports: [sourceImport],
          mocks: [],
          sourceFile,
          coversRules: [finding.ruleId],
          confidence: 0.9,
        });

        // Success Handler Pass-Through
        testCases.push({
          id: `service-interceptor-success-${targetName}`,
          description: `should pass successful responses through without modification`,
          framework,
          body: `  it('should pass successful responses through without modification', () => {\n    const handlers = ${targetName}.interceptors?.response?.handlers || [];\n    const successHandler = handlers[0]?.fulfilled;\n    expect(typeof successHandler).toBe('function');\n\n    const mockResponse = { status: 200, data: { ok: true } };\n    expect(successHandler(mockResponse)).toBe(mockResponse);\n  });`,
          imports: [sourceImport],
          mocks: [],
          sourceFile,
          coversRules: [finding.ruleId],
          confidence: 0.9,
        });
      }
    } else {
      testCases.push({
        id: `service-client-${targetName}`,
        description: `should handle service client operations gracefully (${finding.ruleId})`,
        framework,
        body: `  it('should verify ${targetName} service client initialization (${finding.ruleId})', () => {\n    // Covers ${finding.ruleId} at line ${line}\n    expect(${targetName}).toBeDefined();\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.85,
      });
    }

    return testCases;
  },
};

const STRATEGIES: TestStrategy[] = [
  NullabilityStrategy,
  TaintFlowStrategy,
  ComponentContractStrategy,
  RaceConditionStrategy,
  AsyncPatternStrategy,
  ServiceClientStrategy,
];

/**
 * Get all registered test generation strategies.
 */
export function getAllStrategies(): TestStrategy[] {
  return [...STRATEGIES];
}

/**
 * Get strategies that handle a specific rule id.
 */
export function getStrategiesForRule(ruleId: string): TestStrategy[] {
  return STRATEGIES.filter((s) => s.handlesRules.includes(ruleId));
}

interface ExtractedServiceMethod {
  serviceName?: string;
  isDefaultExport: boolean;
  methodName: string;
  isAsync: boolean;
  params: string[];
  apiCalls: Array<{
    client: string;
    method: string;
    endpoint?: string;
    hasPayload: boolean;
    payloadArgName?: string;
  }>;
  hasCatch: boolean;
  catchThrows: boolean;
  catchLogsError: boolean;
  catchFallbackMessage?: string;
  returnsDataData: boolean;
  returnsData: boolean;
  returnsTrue: boolean;
  mappedProperties: string[];
  helperCalls: string[];
}

/**
 * Generate comprehensive unit tests for exported service modules and functions.
 */
export function generateServiceModuleTests(context: StrategyContext): TestCase[] {
  const { ast, sourceFile, framework } = context;

  // Never treat UI components containing JSX as API service modules
  let hasJsx = false;
  traverse(ast, {
    JSXElement() {
      hasJsx = true;
    },
    JSXFragment() {
      hasJsx = true;
    },
  });
  if (hasJsx) {
    return [];
  }

  const fileExports = getFileExports(ast);
  const spyKeyword = framework === "jest" ? "jest.spyOn" : "vi.spyOn";
  const clearKeyword =
    framework === "jest" ? "jest.clearAllMocks()" : "vi.clearAllMocks()";

  const extractedMethods: ExtractedServiceMethod[] = [];

  const analyzeFunction = (
    fnNode: any,
    methodName: string,
    serviceName?: string,
    isDefaultExport = false,
  ) => {
    const params = (fnNode.params || []).map((p: any) => {
      if (t.isIdentifier(p)) return p.name;
      if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) return p.left.name;
      return "arg";
    });

    const info: ExtractedServiceMethod = {
      serviceName,
      isDefaultExport,
      methodName,
      isAsync: Boolean(fnNode.async),
      params,
      apiCalls: [],
      hasCatch: false,
      catchThrows: false,
      catchLogsError: false,
      catchFallbackMessage: undefined,
      returnsDataData: false,
      returnsData: false,
      returnsTrue: false,
      mappedProperties: [],
      helperCalls: [],
    };

    traverse(fnNode, {
      noScope: true,
      CallExpression(cPath: any) {
        const callee = cPath.node.callee;
        if (
          t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object) &&
          t.isIdentifier(callee.property)
        ) {
          const objName = callee.object.name;
          const propName = callee.property.name;
          if (["get", "post", "put", "delete", "patch"].includes(propName)) {
            const isLocalCollectionOrDom =
              /^(map|set|headers|requestHeaders|responseHeaders|params|searchParams|urlSearchParams|cookies|cache|store|storage|formData|reflect|weakMap|weakSet|listeners|.*Listeners|.*Map|.*Set|.*Cache|.*Headers|localStorage|sessionStorage|document|window|console|Math|JSON|Object|Array|Promise)$/i.test(
                objName,
              );
            const firstArg = cPath.node.arguments[0];
            const endpoint = t.isStringLiteral(firstArg)
              ? firstArg.value
              : t.isTemplateLiteral(firstArg) && firstArg.quasis[0]
                ? firstArg.quasis[0].value.raw
                : undefined;
            const isHttpClientObj =
              /^(api|apiClient|httpClient|client|axios|http|ky|rest|serviceClient|request)$/i.test(
                objName,
              ) ||
              Boolean(
                endpoint &&
                  (endpoint.startsWith("/") || /^https?:\/\//i.test(endpoint)),
              );

            if (!isLocalCollectionOrDom && isHttpClientObj) {
              const hasPayload = cPath.node.arguments.length > 1;
              const secondArg = cPath.node.arguments[1];
              const payloadArgName = t.isIdentifier(secondArg)
                ? secondArg.name
                : undefined;
              info.apiCalls.push({
                client: objName,
                method: propName,
                endpoint,
                hasPayload,
                payloadArgName,
              });
            }
          }
          if (objName === "console" && propName === "error") {
            info.catchLogsError = true;
          }
        } else if (t.isIdentifier(callee)) {
          // Direct function-call HTTP wrappers (e.g. apiRequest, request, fetch)
          // Only treat as a domain service call if this function is not itself the HTTP wrapper definition
          const isWrapperSelf =
            /^(apiRequest|request|fetchClient|httpClient|apiFetch|fetchWithAuth)$/i.test(
              methodName,
            );
          if (
            !isWrapperSelf &&
            /^(apiRequest|request|http|fetch)$/i.test(callee.name)
          ) {
            const firstArg = cPath.node.arguments[0];
            const endpoint = t.isStringLiteral(firstArg)
              ? firstArg.value
              : t.isTemplateLiteral(firstArg) && firstArg.quasis[0]
                ? firstArg.quasis[0].value.raw
                : undefined;
            const secondArg = cPath.node.arguments[1];
            let method = "get";
            let hasPayload = false;

            if (t.isObjectExpression(secondArg)) {
              for (const prop of secondArg.properties) {
                if (
                  t.isObjectProperty(prop) &&
                  t.isIdentifier(prop.key)
                ) {
                  if (prop.key.name === "method" && t.isStringLiteral(prop.value)) {
                    method = prop.value.value.toLowerCase();
                  }
                  if (prop.key.name === "body") {
                    hasPayload = true;
                  }
                }
              }
            }

            info.apiCalls.push({
              client: callee.name,
              method,
              endpoint,
              hasPayload,
            });
          } else if (
            ![
              "Error",
              "Boolean",
              "String",
              "Number",
              "Promise",
              "Object",
              "Array",
            ].includes(callee.name)
          ) {
            info.helperCalls.push(callee.name);
          }
        }
      },
      CatchClause(catPath: any) {
        info.hasCatch = true;
        catPath.traverse({
          noScope: true,
          ThrowStatement() {
            info.catchThrows = true;
          },
          StringLiteral(sStr: any) {
            if (
              sStr.node.value &&
              sStr.node.value.length > 5 &&
              !sStr.node.value.startsWith("/")
            ) {
              if (!info.catchFallbackMessage) {
                info.catchFallbackMessage = sStr.node.value;
              }
            }
          },
        });
      },
      ReturnStatement(rPath: any) {
        const arg = rPath.node.argument;
        if (!arg) return;
        if (t.isBooleanLiteral(arg) && arg.value === true) {
          info.returnsTrue = true;
        } else if (t.isMemberExpression(arg)) {
          if (
            t.isMemberExpression(arg.object) &&
            t.isIdentifier(arg.object.property) &&
            arg.object.property.name === "data" &&
            t.isIdentifier(arg.property) &&
            arg.property.name === "data"
          ) {
            info.returnsDataData = true;
          } else if (
            t.isIdentifier(arg.property) &&
            arg.property.name === "data"
          ) {
            info.returnsData = true;
          }
        } else if (t.isObjectExpression(arg)) {
          info.mappedProperties = arg.properties
            .map((prop: any) =>
              t.isIdentifier(prop.key) ? prop.key.name : undefined,
            )
            .filter(Boolean) as string[];
        }
      },
    });

    extractedMethods.push(info);
  };

  traverse(ast, {
    ExportNamedDeclaration(p: any) {
      const decl = p.node.declaration;
      if (t.isVariableDeclaration(decl)) {
        for (const item of decl.declarations) {
          if (
            t.isIdentifier(item.id) &&
            item.init &&
            t.isObjectExpression(item.init)
          ) {
            const serviceName = item.id.name;
            for (const prop of item.init.properties) {
              if (
                t.isObjectProperty(prop) &&
                t.isIdentifier(prop.key) &&
                (t.isArrowFunctionExpression(prop.value) ||
                  t.isFunctionExpression(prop.value))
              ) {
                analyzeFunction(prop.value, prop.key.name, serviceName, false);
              } else if (t.isObjectMethod(prop) && t.isIdentifier(prop.key)) {
                analyzeFunction(prop, prop.key.name, serviceName, false);
              }
            }
          } else if (
            t.isIdentifier(item.id) &&
            item.init &&
            (t.isArrowFunctionExpression(item.init) ||
              t.isFunctionExpression(item.init))
          ) {
            analyzeFunction(item.init, item.id.name, undefined, false);
          }
        }
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        analyzeFunction(decl, decl.id.name, undefined, false);
      }
    },
    ExportDefaultDeclaration(p: any) {
      const decl = p.node.declaration;
      if (t.isObjectExpression(decl)) {
        for (const prop of decl.properties) {
          if (
            t.isObjectProperty(prop) &&
            t.isIdentifier(prop.key) &&
            (t.isArrowFunctionExpression(prop.value) ||
              t.isFunctionExpression(prop.value))
          ) {
            analyzeFunction(
              prop.value,
              prop.key.name,
              "defaultService",
              true,
            );
          } else if (t.isObjectMethod(prop) && t.isIdentifier(prop.key)) {
            analyzeFunction(prop, prop.key.name, "defaultService", true);
          }
        }
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        analyzeFunction(decl, decl.id.name, undefined, true);
      } else if (
        t.isArrowFunctionExpression(decl) ||
        t.isFunctionExpression(decl)
      ) {
        analyzeFunction(decl, "defaultExport", undefined, true);
      }
    },
  });

  if (extractedMethods.length === 0) {
    return [];
  }

  // Only test methods that actually execute API calls or return API response data
  const actualServiceMethods = extractedMethods.filter(
    (m) => m.apiCalls.length > 0 || m.returnsDataData || m.returnsData,
  );

  if (actualServiceMethods.length === 0) {
    return [];
  }

  const dependencyImports: string[] = [];
  traverse(ast, {
    ImportDeclaration(p: any) {
      const src = p.node.source.value;
      if (src.startsWith("./") || src.startsWith("../") || src.startsWith("@/") || src.startsWith("~/")) {
        const named = p.node.specifiers
          .filter((s: any) => t.isImportSpecifier(s))
          .map((s: any) =>
            t.isIdentifier(s.imported)
              ? s.imported.name
              : (s.imported as any).value,
          );
        const def = p.node.specifiers.find((s: any) =>
          t.isImportDefaultSpecifier(s),
        );
        if (def && named.length > 0) {
          dependencyImports.push(
            `import ${def.local.name}, { ${named.join(", ")} } from '${src}';`,
          );
        } else if (def) {
          dependencyImports.push(`import ${def.local.name} from '${src}';`);
        } else if (named.length > 0) {
          dependencyImports.push(`import { ${named.join(", ")} } from '${src}';`);
        }
      }
    },
  });

  const testCases: TestCase[] = [];
  let isFirstTestCase = true;

  for (const m of actualServiceMethods) {
    const serviceName = m.serviceName;
    const isDefault = m.isDefaultExport;
    const sourceImport = serviceName
      ? sourceImportStatement(sourceFile, [serviceName], isDefault, fileExports)
      : sourceImportStatement(sourceFile, [m.methodName], isDefault, fileExports);

    const allImports = [sourceImport, ...dependencyImports];
    const caller = serviceName ? `${serviceName}.${m.methodName}` : m.methodName;
    const apiCall = m.apiCalls[0];
    const client = apiCall?.client || "apiClient";
    const method = apiCall?.method || "get";
    const endpoint = apiCall?.endpoint || `/api/${m.methodName}`;

    const beforeEachPreamble = isFirstTestCase
      ? `  beforeEach(() => {\n    ${clearKeyword};\n  });\n\n`
      : "";
    isFirstTestCase = false;

    const isDirectFunction = /^(apiRequest|request|fetchApi|queryApi|fetch)$/i.test(client);
    const mockedFn = framework === "vitest" ? `vi.mocked(${client})` : `jest.mocked(${client})`;
    const mockSetup = isDirectFunction
      ? `${mockedFn}.mockResolvedValueOnce`
      : `${client}.${method}.mockResolvedValueOnce`;
    const mockRejectSetup = isDirectFunction
      ? `${mockedFn}.mockRejectedValueOnce`
      : `${client}.${method}.mockRejectedValueOnce`;
    const clientCaller = isDirectFunction ? client : `${client}.${method}`;

    // 1. Success test
    if (m.returnsDataData) {
      testCases.push({
        id: `service-${m.methodName}-success`,
        description: `should successfully call ${endpoint} and return data on ${m.methodName}`,
        framework,
        body: `${beforeEachPreamble}  it('should successfully call ${endpoint} and return data on ${m.methodName}', async () => {\n    const mockPayload = { email: 'test@example.com', password: 'password123' };\n    const mockData = { id: 'usr-123', email: 'test@example.com', token: 'jwt-token-123' };\n    ${mockSetup}({ data: { data: mockData } });\n\n    const result = await ${caller}(mockPayload);\n\n    expect(${clientCaller}).toHaveBeenCalledWith('${endpoint}', mockPayload);\n    expect(result).toEqual(mockData);\n  });`,
        imports: allImports,
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
    } else if (m.mappedProperties.length > 0) {
      const helperCall = m.helperCalls[0];
      const helperSetup = helperCall
        ? `    ${helperCall}.mockReturnValueOnce('color-STF-001');\n`
        : "";
      const helperProp = helperCall ? `\n      colorId: 'color-STF-001',` : "";

      testCases.push({
        id: `service-${m.methodName}-success`,
        description: `should fetch and transform profile data on ${m.methodName}()`,
        framework,
        body: `${beforeEachPreamble}  it('should fetch and transform profile data on ${m.methodName}()', async () => {\n    const mockRawUser = {\n      staff_id: 'STF-001',\n      email: 'jane.doe@example.com',\n      role: 'ADMIN',\n      is_hod: 1,\n      requires_password_change: 0,\n      requires_otp: 1,\n      first_name: 'Jane',\n      last_name: 'Doe',\n    };\n    ${mockSetup}({ data: { data: mockRawUser } });\n${helperSetup}    const result = await ${caller}();\n\n    expect(${clientCaller}).toHaveBeenCalledWith('${endpoint}');\n    expect(result).toEqual({\n      id: 'STF-001',\n      email: 'jane.doe@example.com',\n      role: 'ADMIN',\n      isHod: true,\n      requiresPasswordChange: false,\n      requiresOtp: true,\n      firstName: 'Jane',\n      lastName: 'Doe',\n      initials: 'JD',${helperProp}\n    });\n  });`,
        imports: allImports,
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });

      // Edge case for initials & default booleans
      testCases.push({
        id: `service-${m.methodName}-empty-names`,
        description: `should handle missing names and initials gracefully in ${m.methodName}()`,
        framework,
        body: `  it('should handle missing names and initials gracefully in ${m.methodName}()', async () => {\n    const mockRawUser = {\n      staff_id: 'STF-002',\n      email: 'unknown@example.com',\n      role: 'USER',\n    };\n    ${mockSetup}({ data: { data: mockRawUser } });\n\n    const result = await ${caller}();\n\n    expect(result.firstName).toBe('');\n    expect(result.lastName).toBe('');\n    expect(result.initials).toBe('');\n    expect(result.isHod).toBe(false);\n  });`,
        imports: allImports,
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.9,
      });
    } else if (m.returnsTrue) {
      testCases.push({
        id: `service-${m.methodName}-success`,
        description: `should call ${endpoint} and return true on ${m.methodName}`,
        framework,
        body: `${beforeEachPreamble}  it('should call ${endpoint} and return true on ${m.methodName}', async () => {\n    ${mockSetup}({ data: {} });\n\n    const result = await ${caller}();\n\n    expect(${clientCaller}).toHaveBeenCalledWith('${endpoint}', {});\n    expect(result).toBe(true);\n  });`,
        imports: allImports,
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
    } else if (m.params.length > 0) {
      const isEmail = m.params.includes("email");
      const argValue = isEmail
        ? `'user@example.com'`
        : `{ token: 'token-123', password: 'newPassword!' }`;
      const expectedPayload = isEmail ? `{ email: 'user@example.com' }` : argValue;

      const callAssertion = isDirectFunction
        ? `expect(${clientCaller}).toHaveBeenCalledWith('${endpoint}', expect.anything())`
        : `expect(${clientCaller}).toHaveBeenCalledWith('${endpoint}', ${expectedPayload})`;

      testCases.push({
        id: `service-${m.methodName}-success`,
        description: `should call ${endpoint} with payload on ${m.methodName}`,
        framework,
        body: `${beforeEachPreamble}  it('should call ${endpoint} with payload on ${m.methodName}', async () => {\n    const mockResponseData = { success: true };\n    ${mockSetup}({ data: mockResponseData });\n\n    const result = await ${caller}(${argValue});\n\n    ${callAssertion};\n    expect(result).toBeDefined();\n  });`,
        imports: allImports,
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
    } else {
      testCases.push({
        id: `service-${m.methodName}-success`,
        description: `should call ${endpoint} and return response data on ${m.methodName}`,
        framework,
        body: `${beforeEachPreamble}  it('should call ${endpoint} and return response data on ${m.methodName}', async () => {\n    const mockResponseData = { data: 'test-data' };\n    ${mockSetup}({ data: mockResponseData });\n\n    const result = await ${caller}();\n\n    expect(${clientCaller}).toHaveBeenCalledWith('${endpoint}', expect.anything());\n    expect(result).toBeDefined();\n  });`,
        imports: allImports,
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
    }

    // 2. Error tests
    if (m.hasCatch && m.catchThrows) {
      const paramCall =
        m.params.length > 0
          ? m.params.includes("email")
            ? `'user@example.com'`
            : `{}`
          : "";

      if (
        m.catchFallbackMessage &&
        m.catchFallbackMessage !== "Not authenticated"
      ) {
        testCases.push({
          id: `service-${m.methodName}-server-error`,
          description: `should throw server error message when ${m.methodName} fails`,
          framework,
          body: `  it('should throw server error message when ${m.methodName} fails', async () => {\n    const serverError = {\n      response: {\n        data: { message: 'Server reported failure' },\n      },\n    };\n    ${mockRejectSetup}(serverError);\n\n    await expect(${caller}(${paramCall})).rejects.toThrow('Server reported failure');\n  });`,
          imports: allImports,
          mocks: [],
          sourceFile,
          coversRules: [],
          confidence: 0.95,
        });

        testCases.push({
          id: `service-${m.methodName}-fallback-error`,
          description: `should throw fallback error when ${m.methodName} fails without server message`,
          framework,
          body: `  it('should throw fallback error when ${m.methodName} fails without server message', async () => {\n    ${mockRejectSetup}(new Error('Network error'));\n\n    await expect(${caller}(${paramCall})).rejects.toThrow('${m.catchFallbackMessage}');\n  });`,
          imports: allImports,
          mocks: [],
          sourceFile,
          coversRules: [],
          confidence: 0.95,
        });
      } else {
        const errorMsg = m.catchFallbackMessage || "Not authenticated";
        testCases.push({
          id: `service-${m.methodName}-error`,
          description: `should throw error when ${m.methodName} fails`,
          framework,
          body: `  it('should throw "${errorMsg}" when ${m.methodName} fails', async () => {\n    ${mockRejectSetup}(new Error('API failure'));\n\n    await expect(${caller}(${paramCall})).rejects.toThrow('${errorMsg}');\n  });`,
          imports: allImports,
          mocks: [],
          sourceFile,
          coversRules: [],
          confidence: 0.95,
        });
      }
    } else if (m.hasCatch && m.catchLogsError) {
      testCases.push({
        id: `service-${m.methodName}-log-error`,
        description: `should log to console.error and still return gracefully when ${m.methodName} fails`,
        framework,
        body: `  it('should log to console.error and still return gracefully when ${m.methodName} fails', async () => {\n    const consoleSpy = ${spyKeyword}(console, 'error').mockImplementation(() => {});\n    ${mockRejectSetup}(new Error('Network failure'));\n\n    const result = await ${caller}();\n\n    expect(consoleSpy).toHaveBeenCalled();\n    expect(result).toBe(true);\n    consoleSpy.mockRestore();\n  });`,
        imports: allImports,
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
    }
  }

  return testCases;
}
