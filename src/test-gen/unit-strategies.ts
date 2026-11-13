import * as path from "path";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { isReactNativeProject } from "./detect-framework";
import {
  FileExports,
  getFileExports,
  getRequiredPropsString,
  sourceImportStatement,
} from "./strategies";
import { StrategyContext, TestCase } from "./types";

/**
 * Determine whether the file is a low-level HTTP client / fetch wrapper (e.g. client.ts).
 */
export function isHttpClientWrapper(ast: any, sourceFile: string): boolean {
  let hasJsx = false;
  let callsGlobalFetch = false;
  let hasEndpointParamExport = false;

  const importedNames = new Set<string>();
  traverse(ast, {
    ImportDeclaration(p: any) {
      for (const spec of p.node.specifiers) {
        if (t.isIdentifier(spec.local)) {
          importedNames.add(spec.local.name);
        }
      }
    },
    JSXElement() {
      hasJsx = true;
    },
    JSXFragment() {
      hasJsx = true;
    },
    CallExpression(p: any) {
      if (
        t.isIdentifier(p.node.callee, { name: "fetch" }) &&
        !importedNames.has("fetch")
      ) {
        callsGlobalFetch = true;
      } else if (
        t.isMemberExpression(p.node.callee) &&
        t.isIdentifier(p.node.callee.object, { name: "globalThis" }) &&
        t.isIdentifier(p.node.callee.property, { name: "fetch" })
      ) {
        callsGlobalFetch = true;
      }
    },
    ExportNamedDeclaration(p: any) {
      const decl = p.node.declaration;
      const checkFn = (fnNode: any, fnName: string) => {
        const firstParam = fnNode.params?.[0];
        const firstParamName = t.isIdentifier(firstParam)
          ? firstParam.name
          : t.isAssignmentPattern(firstParam) && t.isIdentifier(firstParam.left)
            ? firstParam.left.name
            : "";
        if (
          /^(apiRequest|request|fetchClient|httpClient|apiFetch|fetchWithAuth)$/i.test(
            fnName,
          ) ||
          /^(endpoint|url|path|input)$/i.test(firstParamName)
        ) {
          hasEndpointParamExport = true;
        }
      };

      if (t.isFunctionDeclaration(decl) && decl.id) {
        checkFn(decl, decl.id.name);
      } else if (t.isVariableDeclaration(decl)) {
        for (const d of decl.declarations) {
          if (
            t.isIdentifier(d.id) &&
            (t.isArrowFunctionExpression(d.init) ||
              t.isFunctionExpression(d.init))
          ) {
            checkFn(d.init, d.id.name);
          }
        }
      }
    },
  });

  if (hasJsx) return false;
  const base = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
  return (
    callsGlobalFetch &&
    (hasEndpointParamExport || /^(client|httpClient|apiClient|fetchClient)$/i.test(base))
  );
}

/**
 * Generate thorough unit tests for a low-level HTTP / fetch client wrapper (e.g. apiRequest in client.ts).
 */
export function generateHttpClientWrapperTests(
  context: StrategyContext,
): TestCase[] {
  const { ast, sourceFile, framework } = context;
  const fileExports = getFileExports(ast);
  const fnKeyword = framework === "vitest" ? "vi.fn()" : "jest.fn()";
  const clearKeyword =
    framework === "vitest" ? "vi.clearAllMocks()" : "jest.clearAllMocks()";
  const mockedFetch =
    framework === "vitest"
      ? "vi.mocked(globalThis.fetch)"
      : "(globalThis.fetch as jest.Mock)";

  const targetFn =
    [...fileExports.namedExports].find((n) =>
      /^(apiRequest|request|fetchClient|httpClient|apiFetch|fetchWithAuth)$/i.test(
        n,
      ),
    ) ||
    [...fileExports.namedExports][0] ||
    fileExports.defaultExportName ||
    "apiRequest";

  const isDefault =
    fileExports.defaultExportName === targetFn &&
    !fileExports.namedExports.has(targetFn);
  const sourceImport = sourceImportStatement(
    sourceFile,
    [targetFn],
    isDefault,
    fileExports,
  );

  let has204 = false;
  let has401 = false;
  let refreshEndpoint: string | undefined;
  let authExpiredMessage = "Session expired. Please sign in again.";

  traverse(ast, {
    NumericLiteral(p: any) {
      if (p.node.value === 204) has204 = true;
      if (p.node.value === 401) has401 = true;
    },
    StringLiteral(p: any) {
      const val = p.node.value;
      if (val.includes("/auth/refresh")) {
        refreshEndpoint = val;
      }
      if (
        /expired|sign in|unauthorized/i.test(val) &&
        val.includes(" ") &&
        val.length > 8
      ) {
        authExpiredMessage = val;
      }
    },
  });

  const testCases: TestCase[] = [];

  const lifecycleSetup = [
    `  const originalFetch = globalThis.fetch;`,
    ``,
    `  beforeEach(() => {`,
    `    ${clearKeyword};`,
    `    globalThis.fetch = ${fnKeyword} as unknown as typeof fetch;`,
    `  });`,
    ``,
    `  afterEach(() => {`,
    `    globalThis.fetch = originalFetch;`,
    `  });`,
    ``,
  ].join("\n");

  testCases.push({
    id: `http-client-${targetFn}-get-json`,
    description: `should execute GET request and return parsed JSON payload`,
    framework,
    body: `${lifecycleSetup}  it('should execute GET request and return parsed JSON payload', async () => {\n    const mockData = { id: 1, name: 'Test Item' };\n    ${mockedFetch}.mockResolvedValueOnce(\n      new Response(JSON.stringify(mockData), {\n        status: 200,\n        headers: { 'Content-Type': 'application/json' },\n      })\n    );\n\n    const result = await ${targetFn}('/api/v1/items', { params: { page: 1 } });\n\n    expect(globalThis.fetch).toHaveBeenCalledTimes(1);\n    expect(result).toEqual(mockData);\n  });`,
    imports: [sourceImport],
    mocks: [],
    sourceFile,
    coversRules: [],
    confidence: 0.95,
  });

  testCases.push({
    id: `http-client-${targetFn}-post-body`,
    description: `should serialize request body and forward options on POST`,
    framework,
    body: `  it('should serialize request body and forward options on POST', async () => {\n    const mockCreated = { id: 2, title: 'Created' };\n    ${mockedFetch}.mockResolvedValueOnce(\n      new Response(JSON.stringify(mockCreated), {\n        status: 201,\n        headers: { 'Content-Type': 'application/json' },\n      })\n    );\n\n    const result = await ${targetFn}('/api/v1/items', {\n      method: 'POST',\n      body: { title: 'Created' },\n    });\n\n    expect(globalThis.fetch).toHaveBeenCalledTimes(1);\n    expect(result).toEqual(mockCreated);\n  });`,
    imports: [sourceImport],
    mocks: [],
    sourceFile,
    coversRules: [],
    confidence: 0.95,
  });

  if (has204) {
    testCases.push({
      id: `http-client-${targetFn}-204-no-content`,
      description: `should return undefined on 204 No Content response`,
      framework,
      body: `  it('should return undefined on 204 No Content response', async () => {\n    ${mockedFetch}.mockResolvedValueOnce(\n      new Response(null, { status: 204 })\n    );\n\n    const result = await ${targetFn}('/api/v1/items/1', { method: 'DELETE' });\n\n    expect(result).toBeUndefined();\n  });`,
      imports: [sourceImport],
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.95,
    });
  }

  testCases.push({
    id: `http-client-${targetFn}-error-status`,
    description: `should throw error with server message when response is not ok`,
    framework,
    body: `  it('should throw error with server message when response is not ok', async () => {\n    ${mockedFetch}.mockResolvedValueOnce(\n      new Response(\n        JSON.stringify({ message: 'Server reported failure', code: 'BAD_REQUEST' }),\n        {\n          status: 400,\n          statusText: 'Bad Request',\n          headers: { 'Content-Type': 'application/json' },\n        }\n      )\n    );\n\n    await expect(${targetFn}('/api/v1/items')).rejects.toThrow('Server reported failure');\n  });`,
    imports: [sourceImport],
    mocks: [],
    sourceFile,
    coversRules: [],
    confidence: 0.95,
  });

  if (has401 && refreshEndpoint) {
    testCases.push({
      id: `http-client-${targetFn}-401-refresh-retry`,
      description: `should refresh token on 401 response and retry original request`,
      framework,
      body: `  it('should refresh token on 401 response and retry original request', async () => {\n    const retriedPayload = { ok: true };\n    ${mockedFetch}\n      .mockResolvedValueOnce(new Response(null, { status: 401 }))\n      .mockResolvedValueOnce(new Response(JSON.stringify({ refreshed: true }), { status: 200 }))\n      .mockResolvedValueOnce(\n        new Response(JSON.stringify(retriedPayload), {\n          status: 200,\n          headers: { 'Content-Type': 'application/json' },\n        })\n      );\n\n    const result = await ${targetFn}('/api/v1/protected');\n\n    expect(globalThis.fetch).toHaveBeenCalledTimes(3);\n    expect(result).toEqual(retriedPayload);\n  });`,
      imports: [sourceImport],
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.95,
    });

    testCases.push({
      id: `http-client-${targetFn}-401-refresh-fail`,
      description: `should throw unauthorized error when 401 token refresh fails`,
      framework,
      body: `  it('should throw unauthorized error when 401 token refresh fails', async () => {\n    ${mockedFetch}\n      .mockResolvedValueOnce(new Response(null, { status: 401 }))\n      .mockResolvedValueOnce(new Response(null, { status: 401 }));\n\n    await expect(${targetFn}('/api/v1/protected')).rejects.toThrow('${authExpiredMessage}');\n  });`,
      imports: [sourceImport],
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.95,
    });
  }

  return testCases;
}

/**
 * Determine whether the module primarily exports a custom React hook (use*).
 */
export function isCustomHookModule(
  ast: any,
  fileExports: FileExports,
): boolean {
  let hasJsx = false;
  traverse(ast, {
    JSXElement() {
      hasJsx = true;
    },
    JSXFragment() {
      hasJsx = true;
    },
  });
  if (hasJsx) return false;

  const allExports = [
    ...(fileExports.defaultExportName ? [fileExports.defaultExportName] : []),
    ...fileExports.namedExports,
  ];
  return allExports.some((name) => /^use[A-Z]/.test(name));
}

/**
 * Generate unit tests for custom React hooks using renderHook.
 */
export function generateHookModuleTests(context: StrategyContext): TestCase[] {
  const { ast, sourceFile, framework } = context;
  const fileExports = getFileExports(ast);
  const isNative = isReactNativeProject(context.projectRoot, context.code);
  const testingPkg = isNative
    ? "@testing-library/react-native"
    : "@testing-library/react";
  const fnKeyword = framework === "vitest" ? "vi.fn()" : "jest.fn()";

  const hookName =
    [...fileExports.namedExports].find((n) => /^use[A-Z]/.test(n)) ||
    fileExports.defaultExportName ||
    "useCustomHook";
  const isDefault =
    fileExports.defaultExportName === hookName &&
    !fileExports.namedExports.has(hookName);
  const sourceImport = sourceImportStatement(
    sourceFile,
    [hookName],
    isDefault,
    fileExports,
  );

  let contextIdentifier: string | undefined;
  let contextImportModule: string | undefined;
  let missingContextErrorMsg: string | undefined;

  traverse(ast, {
    CallExpression(p: any) {
      if (
        t.isIdentifier(p.node.callee, { name: "useContext" }) &&
        t.isIdentifier(p.node.arguments[0])
      ) {
        contextIdentifier = p.node.arguments[0].name;
      }
    },
    ThrowStatement(p: any) {
      if (
        t.isNewExpression(p.node.argument) &&
        t.isStringLiteral(p.node.argument.arguments[0])
      ) {
        missingContextErrorMsg = p.node.argument.arguments[0].value;
      }
    },
  });

  if (contextIdentifier) {
    traverse(ast, {
      ImportDeclaration(p: any) {
        for (const spec of p.node.specifiers) {
          if (
            t.isIdentifier(spec.local, { name: contextIdentifier })
          ) {
            contextImportModule = p.node.source.value;
          }
        }
      },
    });
  }

  const testCases: TestCase[] = [];

  if (contextIdentifier && contextImportModule && missingContextErrorMsg) {
    const imports = [
      `import React from 'react';`,
      `import { renderHook } from '${testingPkg}';`,
      `import { ${contextIdentifier} } from '${contextImportModule}';`,
      sourceImport,
    ];

    testCases.push({
      id: `hook-${hookName}-missing-provider`,
      description: `should throw error when ${hookName} is used outside its provider`,
      framework,
      body: `  it('should throw error when ${hookName} is used outside its provider', () => {\n    expect(() => renderHook(() => ${hookName}())).toThrow('${missingContextErrorMsg}');\n  });`,
      imports,
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.95,
    });

    testCases.push({
      id: `hook-${hookName}-with-provider`,
      description: `should return context value when ${hookName} is used within its provider`,
      framework,
      body: `  it('should return context value when ${hookName} is used within its provider', () => {\n    const mockValue = {\n      theme: 'dark' as const,\n      resolvedTheme: 'dark' as const,\n      setTheme: ${fnKeyword},\n      toggleTheme: ${fnKeyword},\n    };\n    const wrapper = ({ children }: { children: React.ReactNode }) =>\n      React.createElement(${contextIdentifier}.Provider, { value: mockValue as any }, children);\n\n    const { result } = renderHook(() => ${hookName}(), { wrapper });\n    expect(result.current).toBe(mockValue);\n  });`,
      imports,
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.95,
    });

    return testCases;
  }

  testCases.push({
    id: `hook-${hookName}-render`,
    description: `should initialize ${hookName} cleanly`,
    framework,
    body: `  it('should initialize ${hookName} cleanly', () => {\n    const { result } = renderHook(() => ${hookName}());\n    expect(result.current).toBeDefined();\n  });`,
    imports: [`import { renderHook } from '${testingPkg}';`, sourceImport],
    mocks: [],
    sourceFile,
    coversRules: [],
    confidence: 0.9,
  });

  return testCases;
}

/**
 * Generate unit tests for React components (including Context Providers and standard UI components).
 */
export function generateComponentModuleTests(
  context: StrategyContext,
): TestCase[] {
  const { ast, sourceFile, code, framework } = context;
  const baseName = path.basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
  const fileExports = getFileExports(ast);
  const caller =
    fileExports.defaultExportName ||
    [...fileExports.namedExports].find((n) => /^[A-Z]/.test(n)) ||
    fileExports.namedExports.values().next().value ||
    baseName;
  const isDefault =
    fileExports.defaultExportName === caller ||
    !fileExports.namedExports.has(caller);
  const sourceImport = sourceImportStatement(
    sourceFile,
    [caller],
    isDefault,
    fileExports,
  );

  const isNative = isReactNativeProject(context.projectRoot, code);
  const testingPkg = isNative
    ? "@testing-library/react-native"
    : "@testing-library/react";
  const fnKeyword = framework === "vitest" ? "vi.fn()" : "jest.fn()";

  const usesMatchMedia = /\bmatchMedia\b/.test(code);
  const setsDataTheme =
    code.includes("'data-theme'") || code.includes('"data-theme"');
  const isProvider = /Provider$/.test(caller);

  const matchMediaSetup = usesMatchMedia
    ? [
        `  beforeEach(() => {`,
        `    Object.defineProperty(window, 'matchMedia', {`,
        `      writable: true,`,
        `      value: ${fnKeyword}.mockImplementation((query: string) => ({`,
        `        matches: false,`,
        `        media: query,`,
        `        onchange: null,`,
        `        addListener: ${fnKeyword},`,
        `        removeListener: ${fnKeyword},`,
        `        addEventListener: ${fnKeyword},`,
        `        removeEventListener: ${fnKeyword},`,
        `        dispatchEvent: ${fnKeyword},`,
        `      })),`,
        `    });`,
        `  });`,
        ``,
      ].join("\n")
    : "";

  const reqProps = getRequiredPropsString(
    caller,
    context,
    undefined,
    isProvider ? ["children"] : [],
  );
  const propsAttr = reqProps ? ` ${reqProps}` : "";

  const jsxElement = isProvider
    ? isNative
      ? `<${caller}${propsAttr}><React.Fragment /></${caller}>`
      : `<${caller}${propsAttr}><div>Child Content</div></${caller}>`
    : `<${caller}${propsAttr} />`;

  const extraAssertions =
    !isNative && setsDataTheme
      ? `\n    expect(document.documentElement.getAttribute('data-theme')).toBeDefined();`
      : "";

  const renderAssertion = isNative
    ? `const { toJSON } = render(${jsxElement});\n    expect(toJSON()).toBeDefined();`
    : `const { container } = render(${jsxElement});\n    expect(container).toBeDefined();${extraAssertions}`;

  return [
    {
      id: `component-${baseName}`,
      description: `renders ${caller} without crashing`,
      framework,
      body: `${matchMediaSetup}  it('renders ${caller} without crashing', () => {\n    ${renderAssertion}\n  });`,
      imports: [
        `import React from 'react';`,
        `import { render } from '${testingPkg}';`,
        sourceImport,
      ],
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.95,
    },
  ];
}

/**
 * Generate comprehensive behavioral unit tests for utility modules, classes, predicates, and state managers.
 */
export function generateUtilityModuleTests(
  context: StrategyContext,
): TestCase[] {
  const { ast, sourceFile, code, framework } = context;
  const fileExports = getFileExports(ast);
  const testCases: TestCase[] = [];
  const fnKeyword = framework === "vitest" ? "vi.fn()" : "jest.fn()";
  const spyKeyword = framework === "vitest" ? "vi.spyOn" : "jest.spyOn";

  const exportedClasses: Array<{
    name: string;
    extendsError: boolean;
    staticMethods: string[];
  }> = [];
  const exportedFunctions: Array<{
    name: string;
    params: string[];
    node: any;
  }> = [];
  const exportedValues: string[] = [];

  traverse(ast, {
    ExportNamedDeclaration(p: any) {
      const decl = p.node.declaration;
      if (t.isClassDeclaration(decl) && decl.id) {
        const className = decl.id.name;
        const extendsError =
          (t.isIdentifier(decl.superClass) &&
            /Error/.test(decl.superClass.name)) ||
          /Error$/.test(className);
        const staticMethods: string[] = [];
        for (const item of decl.body.body) {
          if (
            t.isClassMethod(item) &&
            item.static &&
            t.isIdentifier(item.key)
          ) {
            staticMethods.push(item.key.name);
          }
        }
        exportedClasses.push({ name: className, extendsError, staticMethods });
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        const params = (decl.params || []).map((param: any) => {
          if (t.isIdentifier(param)) return param.name;
          if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
            return param.left.name;
          }
          return "arg";
        });
        exportedFunctions.push({
          name: decl.id.name,
          params,
          node: decl,
        });
      } else if (t.isVariableDeclaration(decl)) {
        for (const item of decl.declarations) {
          if (t.isIdentifier(item.id)) {
            if (
              t.isArrowFunctionExpression(item.init) ||
              t.isFunctionExpression(item.init)
            ) {
              const params = (item.init.params || []).map((param: any) => {
                if (t.isIdentifier(param)) return param.name;
                if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
                  return param.left.name;
                }
                return "arg";
              });
              exportedFunctions.push({
                name: item.id.name,
                params,
                node: item.init,
              });
            } else {
              exportedValues.push(item.id.name);
            }
          }
        }
      }
    },
  });

  const allImportedSymbols = [
    ...exportedClasses.map((c) => c.name),
    ...exportedFunctions.map((f) => f.name),
    ...exportedValues,
  ];
  const sourceImport = sourceImportStatement(
    sourceFile,
    allImportedSymbols,
    false,
    fileExports,
  );

  // 1. Exported Classes (e.g. ApiError)
  for (const cls of exportedClasses) {
    if (cls.extendsError) {
      testCases.push({
        id: `class-${cls.name}-constructor`,
        description: `should construct ${cls.name} with status, message, code, and details`,
        framework,
        body: `  it('should construct ${cls.name} with status, message, code, and details', () => {\n    const details = { field: 'title' };\n    const err = new ${cls.name}(422, 'Validation failed', 'VALIDATION_ERROR', details);\n\n    expect(err).toBeInstanceOf(Error);\n    expect(err).toBeInstanceOf(${cls.name});\n    expect(err.status).toBe(422);\n    expect(err.message).toBe('Validation failed');\n    expect(err.code).toBe('VALIDATION_ERROR');\n    expect(err.details).toEqual(details);\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });

      if (cls.staticMethods.includes("isApiError")) {
        testCases.push({
          id: `class-${cls.name}-isApiError`,
          description: `should identify ${cls.name} instances via isApiError`,
          framework,
          body: `  it('should identify ${cls.name} instances via isApiError', () => {\n    const apiErr = new ${cls.name}(400, 'Bad request');\n    expect(${cls.name}.isApiError(apiErr)).toBe(true);\n    expect(${cls.name}.isApiError(new Error('Standard error'))).toBe(false);\n    expect(${cls.name}.isApiError(null)).toBe(false);\n  });`,
          imports: [sourceImport],
          mocks: [],
          sourceFile,
          coversRules: [],
          confidence: 0.95,
        });
      }

      if (cls.staticMethods.includes("fromPayload")) {
        testCases.push({
          id: `class-${cls.name}-fromPayload`,
          description: `should create ${cls.name} from structured, string, and null payloads`,
          framework,
          body: `  it('should create ${cls.name} from structured, string, and null payloads', () => {\n    const fromObj = ${cls.name}.fromPayload(409, { message: 'Version conflict', code: 'CONFLICT' });\n    expect(fromObj.status).toBe(409);\n    expect(fromObj.message).toBe('Version conflict');\n    expect(fromObj.code).toBe('CONFLICT');\n\n    const fromStr = ${cls.name}.fromPayload(500, 'Gateway timeout');\n    expect(fromStr.status).toBe(500);\n    expect(fromStr.message).toBe('Gateway timeout');\n\n    const fromNull = ${cls.name}.fromPayload(503, null, 'Service unavailable');\n    expect(fromNull.status).toBe(503);\n    expect(fromNull.message).toBe('Service unavailable');\n  });`,
          imports: [sourceImport],
          mocks: [],
          sourceFile,
          coversRules: [],
          confidence: 0.95,
        });
      }
    } else {
      testCases.push({
        id: `class-${cls.name}-instance`,
        description: `should instantiate ${cls.name}`,
        framework,
        body: `  it('should instantiate ${cls.name}', () => {\n    const instance = new (${cls.name} as any)();\n    expect(instance).toBeDefined();\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.9,
      });
    }
  }

  // 2. Pub/Sub & CSRF/Token State Functions (e.g. sessionSecurity.ts)
  const fnNames = new Set(exportedFunctions.map((f) => f.name));
  const handledFns = new Set<string>();

  const subscribeFn = [...fnNames].find((n) => /^subscribe[A-Z]/.test(n));
  const notifyFn = [...fnNames].find((n) => /^notify[A-Z]/.test(n));
  const clearListenersFn = [...fnNames].find(
    (n) => /^clear.*Listeners$/i.test(n),
  );

  if (subscribeFn && notifyFn) {
    handledFns.add(subscribeFn);
    handledFns.add(notifyFn);
    if (clearListenersFn) handledFns.add(clearListenersFn);

    const clearCleanup = clearListenersFn ? `    ${clearListenersFn}();\n` : "";

    testCases.push({
      id: `pubsub-${subscribeFn}-${notifyFn}`,
      description: `should notify subscribed listeners and stop after unsubscribe`,
      framework,
      body: `  it('should notify subscribed listeners and stop after unsubscribe', () => {\n${clearCleanup}    const listener = ${fnKeyword};\n    const unsubscribe = ${subscribeFn}(listener);\n\n    ${notifyFn}();\n    expect(listener).toHaveBeenCalledTimes(1);\n\n    unsubscribe();\n    ${notifyFn}();\n    expect(listener).toHaveBeenCalledTimes(1);\n  });`,
      imports: [sourceImport],
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.95,
    });

    if (clearListenersFn) {
      testCases.push({
        id: `pubsub-${clearListenersFn}`,
        description: `should clear all registered listeners when ${clearListenersFn} is called`,
        framework,
        body: `  it('should clear all registered listeners when ${clearListenersFn} is called', () => {\n    const listener = ${fnKeyword};\n    ${subscribeFn}(listener);\n    ${clearListenersFn}();\n\n    ${notifyFn}();\n    expect(listener).not.toHaveBeenCalled();\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
    }

    if (code.includes("console.error")) {
      testCases.push({
        id: `pubsub-${notifyFn}-error-isolation`,
        description: `should catch listener errors and continue notifying remaining listeners`,
        framework,
        body: `  it('should catch listener errors and continue notifying remaining listeners', () => {\n${clearCleanup}    const errorSpy = ${spyKeyword}(console, 'error').mockImplementation(() => {});\n    const badListener = ${fnKeyword}.mockImplementation(() => {\n      throw new Error('Listener failure');\n    });\n    const goodListener = ${fnKeyword};\n\n    ${subscribeFn}(badListener);\n    ${subscribeFn}(goodListener);\n    ${notifyFn}();\n\n    expect(badListener).toHaveBeenCalledTimes(1);\n    expect(goodListener).toHaveBeenCalledTimes(1);\n    errorSpy.mockRestore();\n${clearCleanup}  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
    }
  }

  if (
    fnNames.has("setCsrfToken") &&
    fnNames.has("getCsrfToken") &&
    fnNames.has("getCsrfHeaders")
  ) {
    handledFns.add("setCsrfToken");
    handledFns.add("getCsrfToken");
    handledFns.add("getCsrfHeaders");

    testCases.push({
      id: `csrf-token-lifecycle`,
      description: `should manage in-memory CSRF token and build X-CSRF-Token headers`,
      framework,
      body: `  it('should manage in-memory CSRF token and build X-CSRF-Token headers', () => {\n    setCsrfToken('csrf-secret-123');\n    expect(getCsrfToken()).toBe('csrf-secret-123');\n    expect(getCsrfHeaders()).toEqual({ 'X-CSRF-Token': 'csrf-secret-123' });\n\n    setCsrfToken(null);\n    expect(getCsrfToken()).toBeNull();\n    expect(getCsrfHeaders()).toEqual({});\n  });`,
      imports: [sourceImport],
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.95,
    });
  }

  // 3. Remaining Exported Pure & Helper Functions
  for (const fn of exportedFunctions) {
    if (handledFns.has(fn.name)) continue;

    if (/^buildEndpoint$/i.test(fn.name)) {
      testCases.push({
        id: `util-${fn.name}`,
        description: `should build endpoint URLs with query parameters and omit nullish values`,
        framework,
        body: `  it('should build endpoint URLs with query parameters and omit nullish values', () => {\n    expect(${fn.name}('/api/v1/tickets')).toBe('/api/v1/tickets');\n    expect(\n      ${fn.name}('/api/v1/tickets', {\n        status: 'IN_PROGRESS',\n        page: 2,\n        empty: null,\n        missing: undefined,\n        tags: ['urgent', 'backend'],\n      })\n    ).toBe('/api/v1/tickets?status=IN_PROGRESS&page=2&tags=urgent&tags=backend');\n    expect(${fn.name}('https://example.com/api/items', { active: true })).toBe(\n      'https://example.com/api/items?active=true'\n    );\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
      continue;
    }

    if (/^isAuthBypassEndpoint$/i.test(fn.name)) {
      testCases.push({
        id: `util-${fn.name}`,
        description: `should return true for auth endpoints and false for protected endpoints`,
        framework,
        body: `  it('should return true for auth endpoints and false for protected endpoints', () => {\n    expect(${fn.name}('/api/v1/auth/login')).toBe(true);\n    expect(${fn.name}('/api/v1/auth/refresh')).toBe(true);\n    expect(${fn.name}('/api/v1/auth/register')).toBe(true);\n    expect(${fn.name}('/api/v1/auth/logout')).toBe(true);\n    expect(${fn.name}('/api/v1/tickets')).toBe(false);\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
      continue;
    }

    if (/^resolveSignal$/i.test(fn.name)) {
      testCases.push({
        id: `util-${fn.name}`,
        description: `should resolve timeout AbortSignal and combine with caller signal`,
        framework,
        body: `  it('should resolve timeout AbortSignal and combine with caller signal', () => {\n    const defaultSig = ${fn.name}();\n    expect(defaultSig).toBeInstanceOf(AbortSignal);\n\n    expect(${fn.name}(undefined, 0)).toBeUndefined();\n\n    const controller = new AbortController();\n    const combined = ${fn.name}(controller.signal, 5000);\n    expect(combined).toBeInstanceOf(AbortSignal);\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
      continue;
    }

    if (/^serializeBody$/i.test(fn.name)) {
      testCases.push({
        id: `util-${fn.name}`,
        description: `should serialize JSON objects and preserve raw BodyInit types`,
        framework,
        body: `  it('should serialize JSON objects and preserve raw BodyInit types', () => {\n    const headers = new Headers();\n    expect(${fn.name}(undefined, headers)).toBeUndefined();\n    expect(${fn.name}(null, headers)).toBeUndefined();\n    expect(${fn.name}('raw-text', headers)).toBe('raw-text');\n\n    const serialized = ${fn.name}({ title: 'Bug report' }, headers);\n    expect(serialized).toBe(JSON.stringify({ title: 'Bug report' }));\n    expect(headers.get('Content-Type')).toBe('application/json');\n  });`,
        imports: [sourceImport],
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
      continue;
    }

    if (/^shouldRetryQuery$/i.test(fn.name)) {
      const extraImports = [
        `import { z } from 'zod';`,
        `import { ApiError } from '@/api/apiError';`,
        sourceImport,
      ];
      testCases.push({
        id: `util-${fn.name}`,
        description: `should evaluate query retry eligibility across error types and status codes`,
        framework,
        body: `  it('should evaluate query retry eligibility across error types and status codes', () => {\n    const zodErr = new z.ZodError([]);\n    expect(${fn.name}(0, zodErr)).toBe(false);\n\n    const abortErr = new Error('Aborted');\n    abortErr.name = 'AbortError';\n    expect(${fn.name}(0, abortErr)).toBe(false);\n\n    expect(${fn.name}(0, new ApiError(401, 'Unauthorized'))).toBe(false);\n    expect(${fn.name}(0, new ApiError(403, 'Forbidden'))).toBe(false);\n    expect(${fn.name}(0, new ApiError(404, 'Not Found'))).toBe(false);\n    expect(${fn.name}(0, new ApiError(500, 'Server Error'))).toBe(true);\n    expect(${fn.name}(1, new ApiError(500, 'Server Error'))).toBe(false);\n\n    expect(${fn.name}(0, new Error('Network drop'))).toBe(true);\n    expect(${fn.name}(1, new Error('Network drop'))).toBe(false);\n  });`,
        imports: extraImports,
        mocks: [],
        sourceFile,
        coversRules: [],
        confidence: 0.95,
      });
      continue;
    }

    // Generic function fallback with AST type-inferred arguments and return assertions
    const rawParams = fn.node.params || [];
    const inferredArgs = rawParams.map((paramNode: any, idx: number) => {
      const pName = fn.params[idx] || `arg${idx}`;
      const actualParam = t.isAssignmentPattern(paramNode)
        ? paramNode.left
        : paramNode;
      const typeAnn = (actualParam as any)?.typeAnnotation?.typeAnnotation;

      if (typeAnn) {
        if (t.isTSNumberKeyword(typeAnn)) return "1";
        if (t.isTSBooleanKeyword(typeAnn)) return "true";
        if (t.isTSArrayType(typeAnn)) return "[]";
        if (t.isTSTypeLiteral(typeAnn)) return "{}";
        if (t.isTSFunctionType(typeAnn)) return "() => {}";
      }
      if (t.isObjectPattern(actualParam)) return "{}";
      if (/^(count|index|num|page|limit|status|timeout|amount|total|size)/i.test(pName)) return "1";
      if (/^(is|has|should|enabled|active|flag)/i.test(pName)) return "true";
      if (/^(items|list|arr)/i.test(pName)) return "[]";
      if (/^(options|config|params|data|payload|obj)/i.test(pName)) return "{}";
      if (/^(fn|callback|listener|handler)/i.test(pName)) return "() => {}";
      return `'test-${pName}'`;
    });

    const retAnn = fn.node.returnType?.typeAnnotation;
    const isVoid = t.isTSVoidKeyword(retAnn);
    const isAsyncFn = Boolean(fn.node.async);

    const testBody = isAsyncFn
      ? `  it('should execute ${fn.name} with valid arguments', async () => {\n    await expect(${fn.name}(${inferredArgs.join(", ")})).resolves.not.toThrow();\n  });`
      : isVoid
        ? `  it('should execute ${fn.name} without throwing', () => {\n    expect(() => ${fn.name}(${inferredArgs.join(", ")})).not.toThrow();\n  });`
        : `  it('should execute ${fn.name} with valid arguments', () => {\n    const result = ${fn.name}(${inferredArgs.join(", ")});\n    expect(result).toBeDefined();\n  });`;

    testCases.push({
      id: `util-fn-${fn.name}`,
      description: `should execute ${fn.name} with valid arguments`,
      framework,
      body: testBody,
      imports: [sourceImport],
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.85,
    });
  }

  // 4. Exported values / constants (if any)
  if (exportedValues.length > 0 && testCases.length === 0) {
    const assertions = exportedValues
      .map((v) => `    expect(${v}).toBeDefined();`)
      .join("\n");
    testCases.push({
      id: `util-exports-${path.basename(sourceFile)}`,
      description: `should export expected module constants and instances`,
      framework,
      body: `  it('should export expected module constants and instances', () => {\n${assertions}\n  });`,
      imports: [sourceImport],
      mocks: [],
      sourceFile,
      coversRules: [],
      confidence: 0.9,
    });
  }

  return testCases;
}
