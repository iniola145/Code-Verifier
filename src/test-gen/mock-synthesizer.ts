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

  axios: (fw) => ({
    module: "axios",
    isDefault: true,
    factory:
      fw === "jest"
        ? `jest.mock('axios', () => {\n  const reqHandlers = [];\n  const resHandlers = [];\n  const mockAxiosInstance = {\n    defaults: { headers: {} },\n    interceptors: {\n      request: { use: jest.fn((f, r) => { reqHandlers.push({ fulfilled: f, rejected: r }); return reqHandlers.length - 1; }), handlers: reqHandlers },\n      response: { use: jest.fn((f, r) => { resHandlers.push({ fulfilled: f, rejected: r }); return resHandlers.length - 1; }), handlers: resHandlers },\n    },\n    get: jest.fn(() => Promise.resolve({ data: {} })),\n    post: jest.fn(() => Promise.resolve({ data: {} })),\n    put: jest.fn(() => Promise.resolve({ data: {} })),\n    delete: jest.fn(() => Promise.resolve({ data: {} })),\n  };\n  return {\n    __esModule: true,\n    default: {\n      ...mockAxiosInstance,\n      create: jest.fn((cfg) => {\n        mockAxiosInstance.defaults = { ...cfg };\n        return mockAxiosInstance;\n      }),\n    },\n    ...mockAxiosInstance,\n    create: jest.fn((cfg) => {\n      mockAxiosInstance.defaults = { ...cfg };\n      return mockAxiosInstance;\n    }),\n  };\n});`
        : `vi.mock('axios', () => {\n  const reqHandlers = [];\n  const resHandlers = [];\n  const mockAxiosInstance = {\n    defaults: { headers: {} },\n    interceptors: {\n      request: { use: vi.fn((f, r) => { reqHandlers.push({ fulfilled: f, rejected: r }); return reqHandlers.length - 1; }), handlers: reqHandlers },\n      response: { use: vi.fn((f, r) => { resHandlers.push({ fulfilled: f, rejected: r }); return resHandlers.length - 1; }), handlers: resHandlers },\n    },\n    get: vi.fn(() => Promise.resolve({ data: {} })),\n    post: vi.fn(() => Promise.resolve({ data: {} })),\n    put: vi.fn(() => Promise.resolve({ data: {} })),\n    delete: vi.fn(() => Promise.resolve({ data: {} })),\n  };\n  return {\n    __esModule: true,\n    default: {\n      ...mockAxiosInstance,\n      create: vi.fn((cfg) => {\n        mockAxiosInstance.defaults = { ...cfg };\n        return mockAxiosInstance;\n      }),\n    },\n    ...mockAxiosInstance,\n    create: vi.fn((cfg) => {\n      mockAxiosInstance.defaults = { ...cfg };\n      return mockAxiosInstance;\n    }),\n  };\n});`,
  }),
};

/** Core packages that should not be mocked out */
const SKIP_MODULES = new Set([
  "react",
  "react-native",
  "@testing-library/react-native",
  "@testing-library/react",
  "@testing-library/jest-native",
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
      const source = path.node.source.value;
      const info = getOrCreateInfo(source);

      for (const spec of path.node.specifiers) {
        if (t.isImportDefaultSpecifier(spec)) {
          info.defaultSpecifier = spec.local.name;
        } else if (t.isImportSpecifier(spec)) {
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
      if (path.node.source) {
        const source = path.node.source.value;
        const info = getOrCreateInfo(source);
        for (const spec of path.node.specifiers) {
          if (t.isExportSpecifier(spec)) {
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
  const mockCall = framework === "jest" ? "jest.mock" : "vi.mock";

  for (const imp of imports) {
    const mod = imp.module;

    // Skip testing framework & React core
    if (SKIP_MODULES.has(mod)) {
      continue;
    }

    // 1. Well-known packages
    if (WELL_KNOWN_MOCKS[mod]) {
      mocks.push(WELL_KNOWN_MOCKS[mod](framework));
      continue;
    }

    // 2. Relative imports (e.g. ./api, ../services/auth)
    if (mod.startsWith("./") || mod.startsWith("../")) {
      const parts: string[] = [];

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

      const fnBase = framework === "jest" ? "jest.fn" : "vi.fn";

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
        const isApiClient =
          [...methods].some((m) =>
            ["get", "post", "put", "delete", "patch"].includes(m),
          ) || /^(apiClient|client|api|httpClient)$/i.test(named);

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
          parts.push(`${named}: {\n    ${methodProps},\n  }`);
        } else if (methods.size > 0) {
          const methodProps = [...methods]
            .map((m) => `${m}: ${fnKeyword}`)
            .join(",\n    ");
          parts.push(`${named}: {\n    ${methodProps},\n  }`);
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
