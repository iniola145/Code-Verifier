import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { MockSpec, TestFramework } from "./types";

/** Mock templates for well-known third-party packages */
export const WELL_KNOWN_MOCKS: Record<
  string,
  (framework: TestFramework) => MockSpec
> = {
  "@react-navigation/native": (fw) => ({
    module: "@react-navigation/native",
    isDefault: false,
    factory:
      fw === "jest"
        ? `jest.mock('@react-navigation/native', () => ({\n  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),\n  useRoute: () => ({ params: {} }),\n  useFocusEffect: jest.fn(),\n}));`
        : `vi.mock('@react-navigation/native', () => ({\n  useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn() }),\n  useRoute: () => ({ params: {} }),\n  useFocusEffect: vi.fn(),\n}));`,
  }),

  "@react-navigation/stack": (fw) => ({
    module: "@react-navigation/stack",
    isDefault: false,
    factory:
      fw === "jest"
        ? `jest.mock('@react-navigation/stack', () => ({\n  createStackNavigator: () => ({\n    Navigator: ({ children }: { children?: unknown }) => children,\n    Screen: ({ children }: { children?: unknown }) => children,\n  }),\n}));`
        : `vi.mock('@react-navigation/stack', () => ({\n  createStackNavigator: () => ({\n    Navigator: ({ children }: { children?: unknown }) => children,\n    Screen: ({ children }: { children?: unknown }) => children,\n  }),\n}));`,
  }),

  "expo-router": (fw) => ({
    module: "expo-router",
    isDefault: false,
    factory:
      fw === "jest"
        ? `jest.mock('expo-router', () => ({\n  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),\n  useLocalSearchParams: () => ({}),\n  useGlobalSearchParams: () => ({}),\n  Link: 'Link',\n  Stack: { Screen: 'Stack.Screen' },\n}));`
        : `vi.mock('expo-router', () => ({\n  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),\n  useLocalSearchParams: () => ({}),\n  useGlobalSearchParams: () => ({}),\n  Link: 'Link',\n  Stack: { Screen: 'Stack.Screen' },\n}));`,
  }),

  "@react-native-async-storage/async-storage": (fw) => ({
    module: "@react-native-async-storage/async-storage",
    isDefault: true,
    factory:
      fw === "jest"
        ? `jest.mock('@react-native-async-storage/async-storage', () => ({\n  __esModule: true,\n  default: {\n    getItem: jest.fn(() => Promise.resolve(null)),\n    setItem: jest.fn(() => Promise.resolve()),\n    removeItem: jest.fn(() => Promise.resolve()),\n    clear: jest.fn(() => Promise.resolve()),\n  },\n}));`
        : `vi.mock('@react-native-async-storage/async-storage', () => ({\n  __esModule: true,\n  default: {\n    getItem: vi.fn(() => Promise.resolve(null)),\n    setItem: vi.fn(() => Promise.resolve()),\n    removeItem: vi.fn(() => Promise.resolve()),\n    clear: vi.fn(() => Promise.resolve()),\n  },\n}));`,
  }),

  "react-native-webview": (fw) => ({
    module: "react-native-webview",
    isDefault: true,
    factory:
      fw === "jest"
        ? `jest.mock('react-native-webview', () => {\n  const { View } = require('react-native');\n  return { __esModule: true, default: View, WebView: View };\n});`
        : `vi.mock('react-native-webview', () => {\n  const { View } = require('react-native');\n  return { __esModule: true, default: View, WebView: View };\n});`,
  }),

  "react-native-gesture-handler": (fw) => ({
    module: "react-native-gesture-handler",
    isDefault: false,
    factory:
      fw === "jest"
        ? `jest.mock('react-native-gesture-handler', () => ({\n  Swipeable: 'Swipeable',\n  PanGestureHandler: 'PanGestureHandler',\n  State: { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 },\n}));`
        : `vi.mock('react-native-gesture-handler', () => ({\n  Swipeable: 'Swipeable',\n  PanGestureHandler: 'PanGestureHandler',\n  State: { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 },\n}));`,
  }),

  "react-native-reanimated": (fw) => ({
    module: "react-native-reanimated",
    isDefault: false,
    factory:
      fw === "jest"
        ? `jest.mock('react-native-reanimated', () => ({\n  useSharedValue: (v: unknown) => ({ value: v }),\n  useAnimatedStyle: () => ({}),\n  withTiming: (v: unknown) => v,\n  withSpring: (v: unknown) => v,\n  runOnJS: (fn: unknown) => fn,\n}));`
        : `vi.mock('react-native-reanimated', () => ({\n  useSharedValue: (v: unknown) => ({ value: v }),\n  useAnimatedStyle: () => ({}),\n  withTiming: (v: unknown) => v,\n  withSpring: (v: unknown) => v,\n  runOnJS: (fn: unknown) => fn,\n}));`,
  }),

  "expo-linking": (fw) => ({
    module: "expo-linking",
    isDefault: false,
    factory:
      fw === "jest"
        ? `jest.mock('expo-linking', () => ({\n  openURL: jest.fn(() => Promise.resolve()),\n  canOpenURL: jest.fn(() => Promise.resolve(true)),\n  createURL: jest.fn((path: string) => 'myapp://' + path),\n  addEventListener: jest.fn(() => ({ remove: jest.fn() })),\n}));`
        : `vi.mock('expo-linking', () => ({\n  openURL: vi.fn(() => Promise.resolve()),\n  canOpenURL: vi.fn(() => Promise.resolve(true)),\n  createURL: vi.fn((path: string) => 'myapp://' + path),\n  addEventListener: vi.fn(() => ({ remove: vi.fn() })),\n}));`,
  }),

  "expo-secure-store": (fw) => ({
    module: "expo-secure-store",
    isDefault: false,
    factory:
      fw === "jest"
        ? `jest.mock('expo-secure-store', () => ({\n  getItemAsync: jest.fn(() => Promise.resolve(null)),\n  setItemAsync: jest.fn(() => Promise.resolve()),\n  deleteItemAsync: jest.fn(() => Promise.resolve()),\n}));`
        : `vi.mock('expo-secure-store', () => ({\n  getItemAsync: vi.fn(() => Promise.resolve(null)),\n  setItemAsync: vi.fn(() => Promise.resolve()),\n  deleteItemAsync: vi.fn(() => Promise.resolve()),\n}));`,
  }),

  "react-router-dom": (fw) => ({
    module: "react-router-dom",
    isDefault: false,
    factory:
      fw === "jest"
        ? `jest.mock('react-router-dom', () => ({\n  Navigate: ({ to }: { to: any }) => null,\n  Outlet: () => null,\n  useNavigate: () => jest.fn(),\n  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),\n  useParams: () => ({}),\n  Link: ({ children, to }: { children?: any; to?: any }) => children,\n}));`
        : `vi.mock('react-router-dom', () => ({\n  Navigate: ({ to }: { to: any }) => null,\n  Outlet: () => null,\n  useNavigate: () => vi.fn(),\n  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),\n  useParams: () => ({}),\n  Link: ({ children, to }: { children?: any; to?: any }) => children,\n}));`,
  }),

  "lucide-react": (fw) => ({
    module: "lucide-react",
    isDefault: false,
    factory: `${fw === "jest" ? "jest" : "vi"}.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));`,
  }),

  "lucide-react-native": (fw) => ({
    module: "lucide-react-native",
    isDefault: false,
    factory: `${fw === "jest" ? "jest" : "vi"}.mock('lucide-react-native', () => new Proxy({}, { get: () => () => null }));`,
  }),

  axios: (fw) => ({
    module: "axios",
    isDefault: true,
    factory:
      fw === "jest"
        ? `jest.mock('axios', () => {\n  const reqHandlers = [];\n  const resHandlers = [];\n  const mockAxiosInstance = {\n    defaults: { headers: {} },\n    interceptors: {\n      request: { use: jest.fn((f, r) => { reqHandlers.push({ fulfilled: f, rejected: r }); return reqHandlers.length - 1; }), handlers: reqHandlers },\n      response: { use: jest.fn((f, r) => { resHandlers.push({ fulfilled: f, rejected: r }); return resHandlers.length - 1; }), handlers: resHandlers },\n    },\n    get: jest.fn(() => Promise.resolve({ data: {} })),\n    post: jest.fn(() => Promise.resolve({ data: {} })),\n    put: jest.fn(() => Promise.resolve({ data: {} })),\n    delete: jest.fn(() => Promise.resolve({ data: {} })),\n  };\n  return {\n    __esModule: true,\n    default: {\n      ...mockAxiosInstance,\n      create: jest.fn((cfg) => {\n        mockAxiosInstance.defaults = { ...cfg };\n        return mockAxiosInstance;\n      }),\n    },\n    ...mockAxiosInstance,\n    create: jest.fn((cfg) => {\n      mockAxiosInstance.defaults = { ...cfg };\n      return mockAxiosInstance;\n    }),\n  };\n});`
        : `vi.mock('axios', () => {\n  const reqHandlers = [];\n  const resHandlers = [];\n  const mockAxiosInstance = {\n    defaults: { headers: {} },\n    interceptors: {\n      request: { use: vi.fn((f, r) => { reqHandlers.push({ fulfilled: f, rejected: r }); return reqHandlers.length - 1; }), handlers: reqHandlers },\n      response: { use: vi.fn((f, r) => { resHandlers.push({ fulfilled: f, rejected: r }); return resHandlers.length - 1; }), handlers: resHandlers },\n    },\n    get: vi.fn(() => Promise.resolve({ data: {} })),\n    post: vi.fn(() => Promise.resolve({ data: {} })),\n    put: vi.fn(() => Promise.resolve({ data: {} })),\n    delete: vi.fn(() => Promise.resolve({ data: {} })),\n  };\n  return {\n    __esModule: true,\n    default: {\n      ...mockAxiosInstance,\n      create: vi.fn((cfg) => {\n        mockAxiosInstance.defaults = { ...cfg };\n        return mockAxiosInstance;\n      }),\n    },\n    ...mockAxiosInstance,\n    create: vi.fn((cfg) => {\n      mockAxiosInstance.defaults = { ...cfg };\n      return mockAxiosInstance;\n    }),\n  };\n});`,
  }),
};

/** Core and deterministic packages that should not be mocked out with empty objects */
const SKIP_MODULES = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react-native",
  "@testing-library/react-native",
  "@testing-library/react",
  "@testing-library/jest-native",
  "@testing-library/user-event",
  "zod",
  "@tanstack/react-query",
  "clsx",
  "classnames",
  "date-fns",
  "dayjs",
  "moment",
  "lodash",
  "lodash-es",
  "ramda",
  "immer",
  "uuid",
  "nanoid",
  "zustand",
  "jotai",
  "valtio",
  "redux",
  "@reduxjs/toolkit",
  "fs",
  "path",
  "url",
  "util",
  "events",
  "crypto",
  "os",
  "node:fs",
  "node:path",
  "node:url",
  "node:util",
  "node:events",
  "node:crypto",
  "node:os",
]);

interface ImportInfo {
  module: string;
  defaultSpecifier?: string;
  namedSpecifiers: string[];
  namespaceSpecifier?: string;
}

/**
 * Extract imported modules and their specifiers from the AST.
 * Merges multiple import/export declarations for the same module.
 */
function extractImports(ast: any): ImportInfo[] {
  const importsMap = new Map<string, ImportInfo>();

  function getOrCreateInfo(mod: string): ImportInfo {
    let info = importsMap.get(mod);
    if (!info) {
      info = {
        module: mod,
        namedSpecifiers: [],
      };
      importsMap.set(mod, info);
    }
    return info;
  }

  traverse(ast, {
    ImportDeclaration(path) {
      if (path.node.importKind === "type") return;
      const source = path.node.source.value;
      const info = getOrCreateInfo(source);

      for (const spec of path.node.specifiers) {
        if (t.isImportDefaultSpecifier(spec)) {
          info.defaultSpecifier = spec.local.name;
        } else if (t.isImportSpecifier(spec)) {
          if ((spec as any).importKind === "type") continue;
          const importedName = t.isIdentifier(spec.imported)
            ? spec.imported.name
            : (spec.imported as t.StringLiteral).value;
          if (!info.namedSpecifiers.includes(importedName)) {
            info.namedSpecifiers.push(importedName);
          }
        } else if (t.isImportNamespaceSpecifier(spec)) {
          info.namespaceSpecifier = spec.local.name;
        }
      }
    },
    ExportNamedDeclaration(path) {
      if (path.node.exportKind === "type") return;
      if (path.node.source) {
        const source = path.node.source.value;
        const info = getOrCreateInfo(source);
        for (const spec of path.node.specifiers) {
          if (t.isExportSpecifier(spec)) {
            if ((spec as any).exportKind === "type") continue;
            const importedName = t.isIdentifier(spec.local)
              ? spec.local.name
              : (spec.local as any).value;
            if (importedName && !info.namedSpecifiers.includes(importedName)) {
              info.namedSpecifiers.push(importedName);
            }
          }
        }
      }
    },
    ExportAllDeclaration(path) {
      if (path.node.source) {
        getOrCreateInfo(path.node.source.value);
      }
    },
  });

  return [...importsMap.values()];
}

/**
 * Analyze a file's imports and generate mock specifications.
 */
export function synthesizeMocks(ast: any, framework: TestFramework): MockSpec[] {
  const imports = extractImports(ast);
  const mocks: MockSpec[] = [];
  const fnKeyword = framework === "jest" ? "jest.fn()" : "vi.fn()";
  const fnBase = framework === "jest" ? "jest.fn" : "vi.fn";
  const mockCall = framework === "jest" ? "jest.mock" : "vi.mock";

  // Helper to discover member methods accessed on an identifier in the AST
  const getUsedMethods = (identifierName: string): Set<string> => {
    const methods = new Set<string>();
    traverse(ast, {
      MemberExpression(mPath: any) {
        if (
          mPath.node.object &&
          mPath.node.object.name === identifierName &&
          mPath.node.property &&
          mPath.node.property.name
        ) {
          methods.add(mPath.node.property.name);
        }
      },
    });
    return methods;
  };

  // Helper to check how an identifier is used in the AST
  const inspectIdentifierUsage = (identifierName: string) => {
    let usedWithNew = false;
    let usedWithInstanceof = false;
    let isCalled = false;
    let passedToObjectIter = false;
    let usedInJSXMember = false;

    traverse(ast, {
      NewExpression(nPath: any) {
        if (t.isIdentifier(nPath.node.callee, { name: identifierName })) {
          usedWithNew = true;
        }
      },
      BinaryExpression(bPath: any) {
        if (
          bPath.node.operator === "instanceof" &&
          t.isIdentifier(bPath.node.right, { name: identifierName })
        ) {
          usedWithInstanceof = true;
        }
      },
      JSXMemberExpression(jPath: any) {
        if (t.isJSXIdentifier(jPath.node.object, { name: identifierName })) {
          usedInJSXMember = true;
        }
      },
      CallExpression(cPath: any) {
        if (t.isIdentifier(cPath.node.callee, { name: identifierName })) {
          isCalled = true;
          const parent = cPath.parent;
          if (
            t.isSpreadElement(parent) ||
            (t.isCallExpression(parent) &&
              t.isMemberExpression(parent.callee) &&
              t.isIdentifier(parent.callee.object, { name: "Object" }))
          ) {
            passedToObjectIter = true;
          }
        }
      },
    });

    return {
      usedWithNew,
      usedWithInstanceof,
      isCalled,
      passedToObjectIter,
      usedInJSXMember,
    };
  };

  for (const imp of imports) {
    const mod = imp.module;

    // Skip testing framework & deterministic core libraries
    if (SKIP_MODULES.has(mod)) {
      continue;
    }

    // 1. Well-known packages
    if (WELL_KNOWN_MOCKS[mod]) {
      mocks.push(WELL_KNOWN_MOCKS[mod](framework));
      continue;
    }

    // 1b. Static stylesheets and image/media assets
    if (/\.(css|scss|sass|less)$/i.test(mod)) {
      mocks.push({
        module: mod,
        isDefault: false,
        factory: `${mockCall}('${mod}', () => ({}));`,
      });
      continue;
    }
    if (/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(mod)) {
      mocks.push({
        module: mod,
        isDefault: true,
        factory: `${mockCall}('${mod}', () => ({\n  __esModule: true,\n  default: 'test-file-stub',\n}));`,
      });
      continue;
    }

    // 2. Relative or path-aliased imports (e.g. ./api, ../services/auth, @/api/client, ~/utils)
    if (mod.startsWith("./") || mod.startsWith("../") || mod.startsWith("@/") || mod.startsWith("~/")) {
      // Skip mocking pure React Context / constant core modules so Providers and useContext work naturally
      const isPureContextOrConstantsModule =
        !imp.defaultSpecifier &&
        imp.namedSpecifiers.length > 0 &&
        imp.namedSpecifiers.every(
          (n) =>
            /Context$/i.test(n) ||
            /^[A-Z][A-Z0-9_]+$/.test(n) ||
            inspectIdentifierUsage(n).usedInJSXMember,
        );
      if (isPureContextOrConstantsModule) {
        continue;
      }

      const parts: string[] = [];

      if (imp.defaultSpecifier) {
        const methods = getUsedMethods(imp.defaultSpecifier);
        const isApiClient =
          [...methods].some((m) =>
            ["get", "post", "put", "delete", "patch"].includes(m),
          ) ||
          /^(apiClient|client|api|httpClient)$/i.test(imp.defaultSpecifier);

        if (isApiClient) {
          const allMethods = Array.from(
            new Set(["get", "post", "put", "delete", "patch", ...methods]),
          );
          const methodProps = allMethods
            .map(
              (m) =>
                `${m}: ${fnBase}(() => Promise.resolve({ data: {} }))`,
            )
            .join(",\n    ");
          parts.push(`default: {\n    ${methodProps},\n  }`);
        } else if (methods.size > 0) {
          const methodProps = [...methods]
            .map((m) => `${m}: ${fnKeyword}`)
            .join(",\n    ");
          parts.push(`default: {\n    ${methodProps},\n  }`);
        } else {
          parts.push(`default: ${fnKeyword}`);
        }
      }

      for (const named of imp.namedSpecifiers) {
        const methods = getUsedMethods(named);
        const usage = inspectIdentifierUsage(named);
        const isConstant =
          /^[A-Z][A-Z0-9_]+$/.test(named) &&
          (named.includes("_") || named.length >= 3);
        const isErrorOrClass =
          usage.usedWithNew ||
          usage.usedWithInstanceof ||
          /Error$/.test(named);
        const isApiClient =
          !isErrorOrClass &&
          !isConstant &&
          ([...methods].some((m) =>
            ["get", "post", "put", "delete", "patch"].includes(m),
          ) ||
            /^(apiClient|client|api|httpClient)$/i.test(named));

        if (isConstant) {
          const isNumericConst =
            /TIMEOUT|DELAY|MS|INTERVAL|LIMIT|MAX|MIN|PORT|SIZE|COUNT|RETRY|RETRIES|TTL|STALE|GC/i.test(
              named,
            );
          parts.push(
            `${named}: ${isNumericConst ? "1000" : `'test-${named.toLowerCase()}'`}`,
          );
        } else if (isErrorOrClass) {
          const staticHelpers: string[] = [
            `isApiError: ${fnBase}((err: any) => Boolean(err && (err.name === '${named}' || typeof err.status === 'number')))`,
            `fromPayload: ${fnBase}((status: number, payload: any, fallback?: string) => { const msg = (payload && typeof payload === 'object' && payload.message) ? payload.message : (typeof payload === 'string' && payload.length > 0 ? payload : (fallback || \`Request failed with status \${status}\`)); const err: any = new Error(msg); err.name = '${named}'; err.status = status; err.code = (payload && typeof payload === 'object' && payload.code) ? payload.code : \`HTTP_\${status}\`; err.details = payload; return err; })`,
          ];
          for (const m of methods) {
            if (m !== "isApiError" && m !== "fromPayload") {
              staticHelpers.push(`${m}: ${fnKeyword}`);
            }
          }
          parts.push(
            `${named}: Object.assign(class extends Error { status: number; code: string; details?: unknown; constructor(statusOrMsg?: any, message?: string, code = 'API_ERROR', details?: unknown) { const msg = typeof statusOrMsg === 'number' ? (message || \`Request failed with status \${statusOrMsg}\`) : String(statusOrMsg || 'Error'); super(msg); this.name = '${named}'; this.status = typeof statusOrMsg === 'number' ? statusOrMsg : 500; this.code = code; this.details = details; } }, {\n      ${staticHelpers.join(",\n      ")},\n    })`,
          );
        } else if (isApiClient) {
          const allMethods = Array.from(
            new Set(["get", "post", "put", "delete", "patch", ...methods]),
          );
          const methodProps = allMethods
            .map(
              (m) =>
                `${m}: ${fnBase}(() => Promise.resolve({ data: {} }))`,
            )
            .join(",\n    ");
          parts.push(`${named}: {\n    ${methodProps},\n  }`);
        } else if (/^(apiRequest|request|fetchApi|queryApi)$/i.test(named)) {
          parts.push(
            `${named}: ${fnBase}(() => Promise.resolve({ status: 'success', data: {} }))`,
          );
        } else if (/schema$/i.test(named)) {
          parts.push(
            `${named}: {\n    parse: ${fnBase}((val: any) => val),\n    safeParse: ${fnBase}((val: any) => ({ success: true, data: val })),\n  }`,
          );
        } else if (/routes|paths/i.test(named)) {
          parts.push(
            `${named}: new Proxy({}, { get: (_, prop) => typeof prop === 'string' ? '/' + prop.toLowerCase() : '/' })`,
          );
        } else if (/^use[A-Z]/.test(named)) {
          parts.push(
            `${named}: ${fnBase}(() => new Proxy({}, { get: () => undefined }))`,
          );
        } else if (methods.size > 0) {
          const methodProps = [...methods]
            .map((m) => `${m}: ${fnKeyword}`)
            .join(",\n    ");
          parts.push(`${named}: {\n    ${methodProps},\n  }`);
        } else if (usage.isCalled && /^(buildEndpoint|buildUrl|resolveUrl|formatUrl)$/i.test(named)) {
          parts.push(
            `${named}: ${fnBase}((endpoint: string, params?: Record<string, unknown>) => { if (!params) return endpoint; const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => \`\${k}=\${encodeURIComponent(String(v))}\`).join('&'); return qs ? \`\${endpoint}?\${qs}\` : endpoint; })`,
          );
        } else if (usage.isCalled && /^serializeBody$/i.test(named)) {
          parts.push(
            `${named}: ${fnBase}((body: unknown, headers?: Headers) => { if (body === undefined || body === null) return undefined; if (typeof body === 'string') return body; if (headers && typeof headers.has === 'function' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json'); return JSON.stringify(body); })`,
          );
        } else if (usage.isCalled && /^resolveSignal$/i.test(named)) {
          parts.push(
            `${named}: ${fnBase}((sig?: AbortSignal | null) => sig ?? undefined)`,
          );
        } else if (usage.isCalled && /^isAuthBypassEndpoint$/i.test(named)) {
          parts.push(
            `${named}: ${fnBase}((endpoint: string) => /\\/auth\\/(login|refresh|register|logout)$/.test(String(endpoint)))`,
          );
        } else if (usage.passedToObjectIter || (usage.isCalled && /^get.*Headers$/i.test(named))) {
          parts.push(`${named}: ${fnBase}(() => ({}))`);
        } else {
          if (/color/i.test(named)) {
            parts.push(
              `${named}: ${fnBase}((val) => (val ? 'color-' + val : 'default-color'))`,
            );
          } else {
            parts.push(`${named}: ${fnKeyword}`);
          }
        }
      }

      if (imp.namespaceSpecifier && parts.length === 0) {
        parts.push(`default: {}`);
      }

      const bodyContent =
        parts.length > 0
          ? `{\n  __esModule: true,\n  ${parts.join(",\n  ")},\n}`
          : `{}`;

      mocks.push({
        module: mod,
        isDefault: Boolean(imp.defaultSpecifier),
        factory: `${mockCall}('${mod}', () => (${bodyContent}));`,
      });
      continue;
    }

    // 3. Unknown third-party packages: synthesize placeholder
    mocks.push({
      module: mod,
      isDefault: false,
      factory: `// TODO: mock this dependency\n${mockCall}('${mod}', () => ({}));`,
    });
  }

  return mocks;
}

/**
 * Generate the mock code block for a set of mock specs.
 */
export function generateMockCode(
  mocks: MockSpec[],
  framework: TestFramework,
): string {
  if (mocks.length === 0) return "";

  // Deduplicate mocks by module name
  const seen = new Set<string>();
  const uniqueFactories: string[] = [];

  for (const mock of mocks) {
    if (!seen.has(mock.module)) {
      seen.add(mock.module);
      uniqueFactories.push(mock.factory);
    }
  }

  return uniqueFactories.join("\n\n");
}
