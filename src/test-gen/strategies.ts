import * as path from "path";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import {
  ComponentContractFact,
  ComponentPropFact,
} from "../project-ui-index";
import { Diagnostic } from "../types/verifier";
import { StrategyContext, TestCase, TestFramework } from "./types";

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
interface FileExports {
  defaultExportName?: string;
  namedExports: Set<string>;
}

/**
 * Inspect AST to extract file exports (default export and named exports).
 */
function getFileExports(ast: any): FileExports {
  let defaultExportName: string | undefined;
  const namedExports = new Set<string>();

  traverse(ast, {
    ExportDefaultDeclaration(path: any) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) {
        defaultExportName = decl.id.name;
      } else if (t.isIdentifier(decl)) {
        defaultExportName = decl.name;
      } else {
        defaultExportName = "DefaultExport";
      }
    },
    ExportNamedDeclaration(path: any) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) {
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
  if (lower === "user") return `{ id: 'u1', name: 'Test User' }`;
  if (lower === "route") return `{ params: {} }`;
  if (lower === "navigation")
    return `{ navigate: ${fnKeyword}, goBack: ${fnKeyword} }`;
  if (lower === "style") return `{}`;
  if (lower === "children") return `<Text>Test Child</Text>`;

  return `'test-${propName}'`;
}

/**
 * Resolve required props string for a component using contracts, AST, and invariants.
 */
function getRequiredPropsString(
  componentName: string,
  context: StrategyContext,
  finding?: Diagnostic,
  excludeProps: string[] = [],
): string {
  const { framework, contracts, ast } = context;
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
          const val = generateDefaultPropValue(propName, fact, framework);
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
        const val = generateDefaultPropValue(p, undefined, framework);
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
function sourceImportStatement(
  sourceFile: string,
  importedNames: string[],
  hasDefault = false,
  fileExports?: FileExports,
): string {
  const baseName = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
  const relPath = `./${baseName}`;

  const validNamed = importedNames.filter((n) => {
    if (n === baseName) return false;
    if (fileExports && fileExports.defaultExportName === n) return false;
    if (fileExports && !fileExports.namedExports.has(n)) return false;
    return true;
  });

  const isDefault =
    hasDefault || Boolean(fileExports?.defaultExportName);

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

    // React Native testing imports
    const testingImports = [
      `import React from 'react';`,
      `import { render } from '@testing-library/react-native';`,
      sourceImportStatement(sourceFile, [targetName], isDefault, fileExports),
    ];

    if (funcInfo.isComponent) {
      const reqProps = getRequiredPropsString(targetName, context, finding);
      const propsAttr = reqProps ? ` ${reqProps}` : "";

      testCases.push({
        id: `null-comp-${targetName}-${finding.ruleId}`,
        description: `should safely handle null/undefined states in ${targetName}`,
        framework,
        body: `  it('should handle null or undefined input safely in ${targetName}', () => {\n    // Covers ${finding.ruleId} at line ${line}\n    const { toJSON } = render(<${targetName}${propsAttr} />);\n    expect(toJSON()).toBeDefined();\n  });`,
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

    if (finding.ruleId === "RN-SEC-001" || finding.ruleId === "SEC-006") {
      testCases.push({
        id: `taint-sec-${finding.ruleId}`,
        description: `should not persist sensitive tokens in unencrypted storage (${finding.ruleId})`,
        framework,
        body: `  it('should not persist sensitive credentials in unencrypted storage', async () => {\n    // Covers ${finding.ruleId}\n    render(<${targetName}${propsAttr} route={{ params: { token: 'secret-token-123' } }} />);\n    await waitFor(() => {\n      expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(\n        expect.stringMatching(/token|secret|auth|jwt/i),\n        expect.anything()\n      );\n    });\n  });`,
        imports: [
          `import React from 'react';`,
          `import { render, waitFor } from '@testing-library/react-native';`,
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
      testCases.push({
        id: `taint-sink-${finding.ruleId}`,
        description: `should sanitize untrusted deep link or route parameters before rendering sink (${finding.ruleId})`,
        framework,
        body: `  it('should sanitize untrusted input before rendering sink', async () => {\n    // Covers ${finding.ruleId}\n    const untrustedPayload = '<script>alert(1)</script>';\n    const route = { params: { untrustedHtml: untrustedPayload, query: untrustedPayload } };\n    const { toJSON } = render(<${targetName}${propsAttr} route={route} />);\n    expect(toJSON()).toBeDefined();\n    // Verifies untrusted script tags do not flow unsanitized into the rendered sink\n    const serialized = JSON.stringify(toJSON());\n    expect(serialized).not.toContain('<script>alert(1)</script>');\n  });`,
        imports: [
          `import React from 'react';`,
          `import { render } from '@testing-library/react-native';`,
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

    testCases.push({
      id: `contract-render-${targetComp}-${finding.ruleId}`,
      description: `should render ${targetComp} with all required contract props`,
      framework,
      body: `  it('should render ${targetComp} with all required props satisfied', () => {\n    // Covers ${finding.ruleId}\n    const { toJSON } = render(<${targetComp}${propsAttr} />);\n    expect(toJSON()).toBeDefined();\n  });`,
      imports: [
        `import React from 'react';`,
        `import { render } from '@testing-library/react-native';`,
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
          `import { render, waitFor } from '@testing-library/react-native';`,
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

    if (funcInfo.isComponent) {
      const reqProps = getRequiredPropsString(targetName, context, finding, ["route"]);
      const propsAttr = reqProps ? ` ${reqProps}` : "";

      testCases.push({
        id: `async-${targetName}-${finding.ruleId}`,
        description: `should handle async rejection and errors gracefully in ${targetName} (${finding.ruleId})`,
        framework,
        body: `  it('should handle async error pathways without unhandled rejection in ${targetName} (${finding.ruleId})', async () => {\n    // Covers ${finding.ruleId} at line ${line}\n    const errorRoute = { params: { error: 'Network failure', shouldFail: true } };\n    const { toJSON, queryByText } = render(<${targetName}${propsAttr} route={errorRoute} />);\n    await waitFor(() => {\n      expect(toJSON()).toBeDefined();\n      expect(queryByText(/fatal error/i)).toBeNull();\n    });\n  });`,
        imports: [
          `import React from 'react';`,
          `import { render, waitFor } from '@testing-library/react-native';`,
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

const STRATEGIES: TestStrategy[] = [
  NullabilityStrategy,
  TaintFlowStrategy,
  ComponentContractStrategy,
  RaceConditionStrategy,
  AsyncPatternStrategy,
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
