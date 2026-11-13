import * as fs from "fs";
import * as path from "path";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { CodeVerifier } from "../engine";
import { parseSourceCode } from "../parser/ast";
import {
  detectFramework,
  findProjectRoot,
  isReactNativeProject,
  detectDomEnvironment,
} from "./detect-framework";
import { generateMockCode, synthesizeMocks } from "./mock-synthesizer";
import { isHttpClientWrapper } from "./unit-strategies";
import { TestFramework } from "./types";

export interface MethodContract {
  name: string;
  isAsync: boolean;
  params: string[];
  apiEndpoint?: string;
  httpMethod?: string;
  hasCatch: boolean;
  fallbackErrorMessage?: string;
}

export interface ExportedSymbolContract {
  name: string;
  isDefault: boolean;
  kind: "object" | "function" | "class" | "value";
  methods: MethodContract[];
}

export interface TestContextReport {
  filePath: string;
  testFilePath: string;
  framework: TestFramework;
  moduleClassification: "service" | "component" | "hook" | "client" | "utility";
  exports: ExportedSymbolContract[];
  suggestedMocks: string;
  diagnostics: Array<{
    ruleId: string;
    message: string;
    severity: string;
    line: number;
    targetMethod?: string;
  }>;
  guidelines: string[];
}

/**
 * Extract rich semantic and architectural context from a file for an LLM to generate tests.
 */
export async function getTestContextForFile(
  filePath: string,
  codeOverride?: string,
): Promise<TestContextReport> {
  const resolvedPath = path.resolve(filePath);
  const code =
    codeOverride !== undefined
      ? codeOverride
      : fs.readFileSync(resolvedPath, "utf-8");

  const projectRoot = findProjectRoot(path.dirname(resolvedPath));
  const framework = detectFramework(projectRoot);
  const { ast } = parseSourceCode(code, resolvedPath);

  // 1. Synthesize smart mocks
  const mockSpecs = synthesizeMocks(ast, framework);
  const suggestedMocks = generateMockCode(mockSpecs, framework);

  // 2. Run static verification for latent defects
  const verifier = new CodeVerifier({ projectRoot });
  const verifyResult = await verifier.verifyCode(code, resolvedPath);

  // 3. Inspect AST for exports and methods
  const exportsList: ExportedSymbolContract[] = [];
  let hasJsx = false;
  let isHook = false;
  let hasAxiosCreate = false;

  const analyzeMethodNode = (fnNode: any, name: string): MethodContract => {
    const params = (fnNode.params || []).map((p: any) => {
      if (t.isIdentifier(p)) return p.name;
      if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) return p.left.name;
      if (t.isObjectPattern(p)) {
        const props = p.properties
          .map((pr: any) => (t.isObjectProperty(pr) && t.isIdentifier(pr.key) ? pr.key.name : undefined))
          .filter(Boolean);
        return `{ ${props.join(", ")} }`;
      }
      return "arg";
    });

    let apiEndpoint: string | undefined;
    let httpMethod: string | undefined;
    let hasCatch = false;
    let fallbackErrorMessage: string | undefined;

    traverse(fnNode, {
      noScope: true,
      CallExpression(cPath: any) {
        const callee = cPath.node.callee;
        if (
          t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object) &&
          t.isIdentifier(callee.property) &&
          ["get", "post", "put", "delete", "patch"].includes(callee.property.name)
        ) {
          const objName = callee.object.name;
          const isCollectionOrDom =
            /^(map|set|headers|requestHeaders|responseHeaders|params|searchParams|urlSearchParams|cookies|cache|store|storage|formData|reflect|weakMap|weakSet|listeners|.*Listeners|.*Map|.*Set|.*Cache|.*Headers|localStorage|sessionStorage|document|window|console)$/i.test(
              objName,
            );
          const firstArg = cPath.node.arguments[0];
          const rawEndpoint = t.isStringLiteral(firstArg)
            ? firstArg.value
            : t.isTemplateLiteral(firstArg) && firstArg.quasis[0]
              ? firstArg.quasis.map((q: any) => q.value.raw).join("${...}")
              : undefined;
          const isClient =
            /^(api|apiClient|httpClient|client|axios|http|ky|rest|serviceClient|request)$/i.test(
              objName,
            ) ||
            Boolean(
              rawEndpoint &&
                (rawEndpoint.startsWith("/") || /^https?:\/\//i.test(rawEndpoint)),
            );
          if (!isCollectionOrDom && isClient) {
            httpMethod = callee.property.name.toUpperCase();
            apiEndpoint = rawEndpoint;
          }
        } else if (t.isIdentifier(callee) && /^(apiRequest|request|fetchApi|queryApi|fetch)$/i.test(callee.name)) {
          httpMethod = "FETCH";
          const firstArg = cPath.node.arguments[0];
          if (t.isStringLiteral(firstArg)) {
            apiEndpoint = firstArg.value;
          } else if (t.isIdentifier(firstArg)) {
            apiEndpoint = firstArg.name;
          } else if (t.isTemplateLiteral(firstArg) && firstArg.quasis[0]) {
            apiEndpoint = firstArg.quasis.map((q: any) => q.value.raw).join("${...}");
          }
          const secondArg = cPath.node.arguments[1];
          if (t.isObjectExpression(secondArg)) {
            for (const prop of secondArg.properties) {
              if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.key.name === "method" && t.isStringLiteral(prop.value)) {
                httpMethod = prop.value.value.toUpperCase();
              }
            }
          }
        }
      },
      CatchClause(catPath: any) {
        hasCatch = true;
        catPath.traverse({
          noScope: true,
          StringLiteral(s: any) {
            if (s.node.value && s.node.value.length > 5 && !s.node.value.startsWith("/")) {
              if (!fallbackErrorMessage) {
                fallbackErrorMessage = s.node.value;
              }
            }
          },
        });
      },
    });

    return {
      name,
      isAsync: Boolean(fnNode.async),
      params,
      apiEndpoint,
      httpMethod,
      hasCatch,
      fallbackErrorMessage,
    };
  };

  traverse(ast, {
    JSXElement() {
      hasJsx = true;
    },
    JSXFragment() {
      hasJsx = true;
    },
    CallExpression(path: any) {
      if (
        t.isMemberExpression(path.node.callee) &&
        t.isIdentifier(path.node.callee.property) &&
        path.node.callee.property.name === "create"
      ) {
        hasAxiosCreate = true;
      }
    },
    ExportNamedDeclaration(path: any) {
      const decl = path.node.declaration;
      if (t.isVariableDeclaration(decl)) {
        for (const item of decl.declarations) {
          if (t.isIdentifier(item.id)) {
            const symName = item.id.name;
            if (/^use[A-Z]/.test(symName)) isHook = true;

            if (item.init && t.isObjectExpression(item.init)) {
              const methods: MethodContract[] = [];
              for (const prop of item.init.properties) {
                if (
                  t.isObjectProperty(prop) &&
                  t.isIdentifier(prop.key) &&
                  (t.isArrowFunctionExpression(prop.value) || t.isFunctionExpression(prop.value))
                ) {
                  methods.push(analyzeMethodNode(prop.value, prop.key.name));
                } else if (t.isObjectMethod(prop) && t.isIdentifier(prop.key)) {
                  methods.push(analyzeMethodNode(prop, prop.key.name));
                }
              }
              exportsList.push({
                name: symName,
                isDefault: false,
                kind: "object",
                methods,
              });
            } else if (item.init && (t.isArrowFunctionExpression(item.init) || t.isFunctionExpression(item.init))) {
              exportsList.push({
                name: symName,
                isDefault: false,
                kind: "function",
                methods: [analyzeMethodNode(item.init, symName)],
              });
            } else {
              exportsList.push({
                name: symName,
                isDefault: false,
                kind: "value",
                methods: [],
              });
            }
          }
        }
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        const symName = decl.id.name;
        if (/^use[A-Z]/.test(symName)) isHook = true;
        exportsList.push({
          name: symName,
          isDefault: false,
          kind: "function",
          methods: [analyzeMethodNode(decl, symName)],
        });
      } else if (t.isClassDeclaration(decl) && decl.id) {
        const methods: MethodContract[] = [];
        for (const item of decl.body.body) {
          if (t.isClassMethod(item) && t.isIdentifier(item.key)) {
            methods.push(analyzeMethodNode(item, item.key.name));
          }
        }
        exportsList.push({
          name: decl.id.name,
          isDefault: false,
          kind: "class",
          methods,
        });
      }
    },
    ExportDefaultDeclaration(path: any) {
      const decl = path.node.declaration;
      if (t.isObjectExpression(decl)) {
        const methods: MethodContract[] = [];
        for (const prop of decl.properties) {
          if (
            t.isObjectProperty(prop) &&
            t.isIdentifier(prop.key) &&
            (t.isArrowFunctionExpression(prop.value) || t.isFunctionExpression(prop.value))
          ) {
            methods.push(analyzeMethodNode(prop.value, prop.key.name));
          } else if (t.isObjectMethod(prop) && t.isIdentifier(prop.key)) {
            methods.push(analyzeMethodNode(prop, prop.key.name));
          }
        }
        exportsList.push({
          name: "default",
          isDefault: true,
          kind: "object",
          methods,
        });
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        exportsList.push({
          name: decl.id.name,
          isDefault: true,
          kind: "function",
          methods: [analyzeMethodNode(decl, decl.id.name)],
        });
      }
    },
  });

  // 4. Determine classification
  let moduleClassification: TestContextReport["moduleClassification"] = "utility";
  if (hasJsx) {
    moduleClassification = "component";
  } else if (isHook) {
    moduleClassification = "hook";
  } else if (hasAxiosCreate || isHttpClientWrapper(ast, resolvedPath)) {
    moduleClassification = "client";
  } else if (
    exportsList.some((e) => e.methods.some((m) => Boolean(m.apiEndpoint) || Boolean(m.httpMethod))) ||
    /service/i.test(resolvedPath)
  ) {
    moduleClassification = "service";
  }

  // 5. Correlate diagnostics to specific methods
  const diagnostics = verifyResult.diagnostics.map((d) => {
    let targetMethod: string | undefined;
    for (const exp of exportsList) {
      for (const m of exp.methods) {
        // approximate match based on finding line
        targetMethod = m.name;
      }
    }
    return {
      ruleId: d.ruleId,
      message: d.message,
      severity: d.severity,
      line: d.loc?.start?.line || 1,
      targetMethod,
    };
  });

  const testFilePath = resolvedPath.replace(/\.(tsx?|jsx?)$/, ".test.$1");

  const guidelines: string[] = [
    `Use ${framework === "vitest" ? "Vitest (import { describe, it, expect, vi, beforeEach } from 'vitest')" : "Jest"}.`,
    `Ensure clean state between tests using beforeEach(() => { ${framework === "vitest" ? "vi.clearAllMocks()" : "jest.clearAllMocks()"}; }).`,
  ];

  const isNative = isReactNativeProject(projectRoot, code);

  if (moduleClassification === "service") {
    guidelines.push("Mock all HTTP calls and verify expected URLs, payloads, and returned responses.");
    guidelines.push("Test both happy paths and server rejection/error handling with fallback messages.");
  } else if (moduleClassification === "component") {
    const testingLib = isNative ? "@testing-library/react-native" : "@testing-library/react";
    const domEnv = detectDomEnvironment(projectRoot);

    if (!isNative && (!domEnv.hasDomRunner || !domEnv.hasTestingLibrary)) {
      guidelines.push(
        "CRITICAL ARCHITECTURAL WARNING: Target project lacks a DOM test runner (jsdom/happy-dom) or @testing-library/react.",
        "DO NOT attempt to monkey-patch React private internals (React.__CLIENT_INTERNALS), do NOT invoke components as plain functions (e.g. Component()), and do NOT traverse element child indices.",
        "Proper component testing requires @testing-library/react with render(<Component />). Strongly recommend adding '@testing-library/react' and 'jsdom' (or 'happy-dom') to devDependencies, or test the underlying hooks and services independently."
      );
    } else {
      guidelines.push(
        `Render components with standard JSX (<Component />) using ${testingLib} and test user interactions, states, and DOM outputs.`
      );
    }
  } else if (moduleClassification === "client") {
    guidelines.push("Test client defaults (timeout, headers, withCredentials) and response/request interceptors.");
  }

  if (diagnostics.length > 0) {
    guidelines.push(
      `CRITICAL DEFECTS DETECTED: Must generate explicit test cases covering rules: ${diagnostics.map((d) => d.ruleId).join(", ")}.`,
    );
  }

  return {
    filePath: resolvedPath,
    testFilePath,
    framework,
    moduleClassification,
    exports: exportsList,
    suggestedMocks,
    diagnostics,
    guidelines,
  };
}
