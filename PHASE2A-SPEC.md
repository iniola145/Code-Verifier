# Phase 2A Specification: Test Generation from Static Facts

## Overview

This document is a self-contained specification for implementing Phase 2A of Code Verifier. The implementer should be able to execute this plan without additional context.

**Goal:** Generate runnable test suites from the existing static analysis engine — no runtime dependencies.

**Deliverable:** `code-verifier --generate-tests ./src/ --output ./tests/` produces runnable test files.

---

## 1. File Structure

### New files to create

```
src/test-gen/
  types.ts              — Type definitions for test generation
  generator.ts          — Main orchestrator
  strategies.ts         — Test generation strategies
  templates.ts          — Test file templates
  mock-synthesizer.ts   — Import inspection and mock generation
  frameworks/
    jest.ts             — Jest-specific generator
    vitest.ts           — Vitest-specific generator
    detox.ts            — Detox-specific generator (stub for now)
```

### Files to modify

```
src/cli.ts              — Add --generate-tests, --framework, --output, --in-place flags
src/mcp-server.ts       — Add generate_tests tool
package.json            — Add exports subpaths (after Phase 2B)
```

---

## 2. Type Definitions (`src/test-gen/types.ts`)

```typescript
/** Supported test frameworks */
export type TestFramework = 'jest' | 'vitest' | 'detox';

/** Output mode for generated tests */
export type OutputMode = 'directory' | 'in-place';

/** A single test case to generate */
export interface TestCase {
  /** Unique identifier for this test */
  id: string;
  /** Human-readable description */
  description: string;
  /** The test framework this test targets */
  framework: TestFramework;
  /** The test file content (without imports/mocks) */
  body: string;
  /** Required imports for this test */
  imports: string[];
  /** Required mocks for this test */
  mocks: MockSpec[];
  /** The source file this test covers */
  sourceFile: string;
  /** The rule IDs this test covers */
  coversRules: string[];
  /** Confidence that this test will catch the bug (0-1) */
  confidence: number;
}

/** A mock specification */
export interface MockSpec {
  /** The module to mock (e.g. '@react-navigation/native') */
  module: string;
  /** The mock factory code */
  factory: string;
  /** Whether this is a default export mock */
  isDefault: boolean;
}

/** Result of test generation for a single file */
export interface GeneratedTest {
  /** The test file path (relative to output dir) */
  filePath: string;
  /** The complete test file content */
  content: string;
  /** The framework used */
  framework: TestFramework;
  /** Test cases in this file */
  testCases: TestCase[];
  /** Source file this test covers */
  sourceFile: string;
}

/** Options for test generation */
export interface TestGenOptions {
  /** Target framework (auto-detected if not specified) */
  framework?: TestFramework;
  /** Output directory (for directory mode) */
  outputDir?: string;
  /** Output mode */
  mode: OutputMode;
  /** Specific rule IDs to generate tests for (empty = all) */
  ruleFilter?: string[];
  /** Whether to include setup files (jest-setup, etc.) */
  includeSetup: boolean;
}

/** Context passed to strategies */
export interface StrategyContext {
  /** The source file being analyzed */
  sourceFile: string;
  /** The source code */
  code: string;
  /** The Babel AST */
  ast: any;
  /** Static analysis findings for this file */
  findings: any[];
  /** Component contracts from ProjectUiIndex */
  contracts: any[];
  /** Function summaries */
  functionSummaries: any[];
  /** The target framework */
  framework: TestFramework;
  /** The project root */
  projectRoot: string;
}
```

---

## 3. Mock Synthesizer (`src/test-gen/mock-synthesizer.ts`)

### Purpose

Inspect a target file's imports and generate appropriate mock code so generated tests don't crash at import time.

### API

```typescript
/**
 * Analyze a file's imports and generate mock specifications.
 * @param ast - The Babel AST of the target file
 * @param framework - The target test framework
 * @returns Array of mock specifications
 */
export function synthesizeMocks(ast: any, framework: TestFramework): MockSpec[];

/**
 * Generate the mock code block for a set of mock specs.
 * @param mocks - The mock specifications
 * @param framework - The target test framework
 * @returns The mock code as a string
 */
export function generateMockCode(mocks: MockSpec[], framework: TestFramework): string;
```

### Mock templates for well-known packages

```typescript
const WELL_KNOWN_MOCKS: Record<string, (framework: TestFramework) => MockSpec> = {
  '@react-navigation/native': (fw) => ({
    module: '@react-navigation/native',
    isDefault: false,
    factory: fw === 'jest'
      ? `jest.mock('@react-navigation/native', () => ({
        useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
        useRoute: () => ({ params: {} }),
        useFocusEffect: jest.fn(),
      }));`
      : `vi.mock('@react-navigation/native', () => ({
        useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn() }),
        useRoute: () => ({ params: {} }),
        useFocusEffect: vi.fn(),
      }));`,
  }),

  'expo-router': (fw) => ({
    module: 'expo-router',
    isDefault: false,
    factory: fw === 'jest'
      ? `jest.mock('expo-router', () => ({
        useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
        useLocalSearchParams: () => ({}),
        useGlobalSearchParams: () => ({}),
        Link: 'Link',
        Stack: { Screen: 'Stack.Screen' },
      }));`
      : `vi.mock('expo-router', () => ({
        useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
        useLocalSearchParams: () => ({}),
        useGlobalSearchParams: () => ({}),
        Link: 'Link',
        Stack: { Screen: 'Stack.Screen' },
      }));`,
  }),

  '@react-native-async-storage/async-storage': (fw) => ({
    module: '@react-native-async-storage/async-storage',
    isDefault: true,
    factory: fw === 'jest'
      ? `jest.mock('@react-native-async-storage/async-storage', () => ({
        __esModule: true,
        default: {
          getItem: jest.fn(() => Promise.resolve(null)),
          setItem: jest.fn(() => Promise.resolve()),
          removeItem: jest.fn(() => Promise.resolve()),
          clear: jest.fn(() => Promise.resolve()),
        },
      }));`
      : `vi.mock('@react-native-async-storage/async-storage', () => ({
        __esModule: true,
        default: {
          getItem: vi.fn(() => Promise.resolve(null)),
          setItem: vi.fn(() => Promise.resolve()),
          removeItem: vi.fn(() => Promise.resolve()),
          clear: vi.fn(() => Promise.resolve()),
        },
      }));`,
  }),

  'react-native-webview': (fw) => ({
    module: 'react-native-webview',
    isDefault: true,
    factory: fw === 'jest'
      ? `jest.mock('react-native-webview', () => {
        const { View } = require('react-native');
        return { __esModule: true, default: View };
      });`
      : `vi.mock('react-native-webview', () => {
        const { View } = require('react-native');
        return { __esModule: true, default: View };
      });`,
  }),

  'react-native-gesture-handler': (fw) => ({
    module: 'react-native-gesture-handler',
    isDefault: false,
    factory: fw === 'jest'
      ? `jest.mock('react-native-gesture-handler', () => ({
        Swipeable: 'Swipeable',
        PanGestureHandler: 'PanGestureHandler',
        State: { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 },
      }));`
      : `vi.mock('react-native-gesture-handler', () => ({
        Swipeable: 'Swipeable',
        PanGestureHandler: 'PanGestureHandler',
        State: { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 },
      }));`,
  }),

  'react-native-reanimated': (fw) => ({
    module: 'react-native-reanimated',
    isDefault: false,
    factory: fw === 'jest'
      ? `jest.mock('react-native-reanimated', () => ({
        useSharedValue: (v) => ({ value: v }),
        useAnimatedStyle: () => ({}),
        withTiming: (v) => v,
        withSpring: (v) => v,
        runOnJS: (fn) => fn,
      }));`
      : `vi.mock('react-native-reanimated', () => ({
        useSharedValue: (v) => ({ value: v }),
        useAnimatedStyle: () => ({}),
        withTiming: (v) => v,
        withSpring: (v) => v,
        runOnJS: (fn) => fn,
      }));`,
  }),
};
```

### Relative import handling

For relative imports (e.g. `./api`, `../services/auth`), generate a spy-based mock:

```typescript
// For: import { login, fetchUser } from './api';
// Generate:
jest.mock('./api', () => ({
  login: jest.fn(),
  fetchUser: jest.fn(),
}));
```

### Unknown import handling

For unknown imports, generate a placeholder:

```typescript
// TODO: mock this dependency
jest.mock('some-unknown-package', () => ({}));
```

---

## 4. Test Generation Strategies (`src/test-gen/strategies.ts`)

### Purpose

Each strategy converts a specific type of static finding into test cases.

### API

```typescript
/**
 * A test generation strategy.
 */
export interface TestStrategy {
  /** The rule IDs this strategy handles */
  handlesRules: string[];
  /** Generate test cases for a finding */
  generate(context: StrategyContext, finding: any): TestCase[];
}

/**
 * Get all available strategies.
 */
export function getAllStrategies(): TestStrategy[];

/**
 * Get strategies that handle a specific rule.
 */
export function getStrategiesForRule(ruleId: string): TestStrategy[];
```

### Strategy 1: Nullability Test (handles AI-NULL-001, LOGIC-004)

```typescript
const NullabilityStrategy: TestStrategy = {
  handlesRules: ['AI-NULL-001', 'LOGIC-004'],

  generate(context, finding) {
    const { code, ast, framework } = context;
    const testCases: TestCase[] = [];

    // Extract the function containing the finding
    const functionName = finding.loc?.functionName || 'unknown';
    const paramNames = extractFunctionParams(ast, functionName);

    // Generate null/undefined test for each parameter
    for (const param of paramNames) {
      testCases.push({
        id: `null-${param}`,
        description: `should handle null ${param}`,
        framework,
        body: `
  it('should handle null ${param}', () => {
    const result = ${functionName}(${param === paramNames[0] ? 'null' : paramNames.map(p => p === param ? 'null' : 'validValue').join(', ')});
    expect(result).toBeDefined();
  });
  ${paramNames.length > 1 ? `
  it('should handle undefined ${param}', () => {
    const result = ${functionName}(${paramNames.map(p => p === param ? 'undefined' : 'validValue').join(', ')});
    expect(result).toBeDefined();
  });` : ''}`,
        imports: [`import { ${functionName} } from './${context.sourceFile}';`],
        mocks: [],
        sourceFile: context.sourceFile,
        coversRules: [finding.ruleId],
        confidence: 0.8,
      });
    }

    return testCases;
  },
};
```

### Strategy 2: Taint Flow Test (handles AI-TAINT-001, RN-SEC-001)

```typescript
const TaintFlowStrategy: TestStrategy = {
  handlesRules: ['AI-TAINT-001', 'RN-SEC-001'],

  generate(context, finding) {
    const { framework } = context;
    const testCases: TestCase[] = [];

    // Generate a test that passes untrusted input and verifies the sink
    testCases.push({
      id: `taint-${finding.ruleId}`,
      description: `should not persist untrusted input from ${finding.message}`,
      framework,
      body: `
  it('should not persist untrusted input', async () => {
    const untrustedInput = 'malicious_value';
    // TODO: trigger the taint flow with untrusted input
    // TODO: verify the sink was not called with untrusted input
    expect(true).toBe(true); // placeholder
  });`,
      imports: [],
      mocks: [],
      sourceFile: context.sourceFile,
      coversRules: [finding.ruleId],
      confidence: 0.6,
    });

    return testCases;
  },
};
```

### Strategy 3: Component Contract Test (handles COMP-001, COMP-003)

```typescript
const ComponentContractStrategy: TestStrategy = {
  handlesRules: ['COMP-001', 'COMP-003'],

  generate(context, finding) {
    const { framework, contracts } = context;
    const testCases: TestCase[] = [];

    // Find the component contract for this finding
    const contract = contracts.find(c => c.componentName === finding.loc?.componentName);
    if (!contract) return testCases;

    // Generate a test with all required props
    const requiredProps = contract.requiredProps.map(p => `${p}: ${generateDefaultValue(p)}`).join(', ');
    testCases.push({
      id: `contract-${contract.componentName}`,
      description: `should render with required props`,
      framework,
      body: `
  it('should render with required props', () => {
    const props = { ${requiredProps} };
    render(<${contract.componentName} {...props} />);
    expect(screen.getByTestId('${contract.componentName}')).toBeTruthy();
  });`,
      imports: [
        `import { render, screen } from '@testing-library/react-native';`,
        `import { ${contract.componentName} } from './${context.sourceFile}';`,
      ],
      mocks: [],
      sourceFile: context.sourceFile,
      coversRules: [finding.ruleId],
      confidence: 0.9,
    });

    return testCases;
  },
};
```

### Strategy 4: Race Condition Test (handles RACE-001 through RACE-010)

```typescript
const RaceConditionStrategy: TestStrategy = {
  handlesRules: ['RACE-001', 'RACE-002', 'RACE-003', 'RACE-004', 'RACE-005', 'RACE-006', 'RACE-007', 'RACE-008', 'RACE-009', 'RACE-010'],

  generate(context, finding) {
    const { framework } = context;
    const testCases: TestCase[] = [];

    testCases.push({
      id: `race-${finding.ruleId}`,
      description: `should handle concurrent operations without race condition`,
      framework,
      body: `
  it('should handle concurrent operations', async () => {
    // TODO: set up concurrent operations
    // TODO: verify no race condition
    expect(true).toBe(true); // placeholder
  });`,
      imports: [],
      mocks: [],
      sourceFile: context.sourceFile,
      coversRules: [finding.ruleId],
      confidence: 0.5,
    });

    return testCases;
  },
};
```

### Strategy 5: Async Pattern Test (handles ASYNC-001, ASYNC-002, TYPE-001)

```typescript
const AsyncPatternStrategy: TestStrategy = {
  handlesRules: ['ASYNC-001', 'ASYNC-002', 'TYPE-001'],

  generate(context, finding) {
    const { framework } = context;
    const testCases: TestCase[] = [];

    testCases.push({
      id: `async-${finding.ruleId}`,
      description: `should handle async rejection`,
      framework,
      body: `
  it('should handle async rejection', async () => {
    // TODO: mock async operation to reject
    // TODO: verify rejection is handled
    expect(true).toBe(true); // placeholder
  });`,
      imports: [],
      mocks: [],
      sourceFile: context.sourceFile,
      coversRules: [finding.ruleId],
      confidence: 0.6,
    });

    return testCases;
  },
};
```

---

## 5. Test Templates (`src/test-gen/templates.ts`)

### Purpose

Generate the complete test file content from test cases.

### API

```typescript
/**
 * Generate a complete test file from test cases.
 * @param testCases - The test cases to include
 * @param framework - The target framework
 * @param sourceFile - The source file being tested
 * @returns The complete test file content
 */
export function generateTestFile(
  testCases: TestCase[],
  framework: TestFramework,
  sourceFile: string
): string;
```

### Template structure

```typescript
function generateTestFile(testCases, framework, sourceFile): string {
  const frameworkName = framework === 'jest' ? 'Jest' : framework === 'vitest' ? 'Vitest' : 'Detox';
  const allImports = [...new Set(testCases.flatMap(tc => tc.imports))];
  const allMocks = [...new Set(testCases.flatMap(tc => tc.mocks.map(m => m.factory)))];
  const allRules = [...new Set(testCases.flatMap(tc => tc.coversRules))];

  return `// Generated by Code Verifier on ${new Date().toISOString().split('T')[0]}
// Source: ${sourceFile}
// Covers: ${allRules.join(', ')}
// Framework: ${frameworkName}

${allMocks.join('\n\n')}

${allImports.join('\n')}

describe('${sourceFile}', () => {
${testCases.map(tc => tc.body).join('\n\n')}
});
`;
}
```

---

## 6. Framework-Specific Generators

### Jest (`src/test-gen/frameworks/jest.ts`)

```typescript
import { TestFramework } from '../types';

export const jestFramework: TestFramework = 'jest';

/**
 * Generate Jest-specific test code.
 */
export function generateJestTest(testCases: TestCase[], sourceFile: string): string {
  return generateTestFile(testCases, 'jest', sourceFile);
}

/**
 * Generate Jest setup file content.
 */
export function generateJestSetup(): string {
  return `// Code Verifier Jest Setup
// Add to jest.config.js: setupFilesAfterEnv: ['code-verifier/jest-setup']

const originalError = console.error;
console.error = (...args) => {
  // Capture errors for Code Verifier analysis
  if (typeof window !== 'undefined' && window.__cv_captureError) {
    window.__cv_captureError(args);
  }
  originalError.apply(console, args);
};

process.on('unhandledRejection', (reason) => {
  if (typeof window !== 'undefined' && window.__cv_captureRejection) {
    window.__cv_captureRejection(reason);
  }
});
`;
}
```

### Vitest (`src/test-gen/frameworks/vitest.ts`)

```typescript
import { TestFramework } from '../types';

export const vitestFramework: TestFramework = 'vitest';

/**
 * Generate Vitest-specific test code.
 */
export function generateVitestTest(testCases: TestCase[], sourceFile: string): string {
  return generateTestFile(testCases, 'vitest', sourceFile);
}
```

### Detox (`src/test-gen/frameworks/detox.ts`)

```typescript
import { TestFramework } from '../types';

export const detoxFramework: TestFramework = 'detox';

/**
 * Generate Detox-specific test code (stub for now).
 */
export function generateDetoxTest(testCases: TestCase[], sourceFile: string): string {
  // TODO: Implement Detox E2E test generation
  return `// Detox test generation not yet implemented
// Source: ${sourceFile}
`;
}
```

---

## 7. Main Generator (`src/test-gen/generator.ts`)

### Purpose

Orchestrate the entire test generation process.

### API

```typescript
/**
 * Generate tests for a set of files.
 * @param files - The source files to analyze
 * @param options - Test generation options
 * @returns Array of generated test files
 */
export async function generateTests(
  files: string[],
  options: TestGenOptions
): Promise<GeneratedTest[]>;

/**
 * Detect the test framework from a project's package.json.
 * @param projectRoot - The project root directory
 * @returns The detected framework
 */
export function detectFramework(projectRoot: string): TestFramework;

/**
 * Generate tests for a single file.
 * @param filePath - The source file path
 * @param options - Test generation options
 * @returns The generated test file
 */
export function generateTestsForFile(
  filePath: string,
  options: TestGenOptions
): GeneratedTest;
```

### Implementation outline

```typescript
export async function generateTests(files: string[], options: TestGenOptions): Promise<GeneratedTest[]> {
  const framework = options.framework || detectFramework(options.outputDir || '.');
  const results: GeneratedTest[] = [];

  for (const file of files) {
    const result = generateTestsForFile(file, { ...options, framework });
    if (result) {
      results.push(result);
    }
  }

  return results;
}

export function detectFramework(projectRoot: string): TestFramework {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'jest'; // default

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (allDeps.vitest) return 'vitest';
  if (allDeps.jest || allDeps['react-native'] || allDeps.expo) return 'jest';
  return 'jest'; // default
}

export function generateTestsForFile(filePath: string, options: TestGenOptions): GeneratedTest {
  // 1. Read and parse the source file
  const code = fs.readFileSync(filePath, 'utf-8');
  const ast = parseSourceCode(code, filePath).ast;

  // 2. Run static analysis to get findings
  const verifier = new CodeVerifier(/* ... */);
  const result = await verifier.verifyFile(filePath);

  // 3. Get component contracts from ProjectUiIndex
  const contracts = /* from ProjectUiIndex */;

  // 4. Synthesize mocks
  const mocks = synthesizeMocks(ast, options.framework);

  // 5. Generate test cases using strategies
  const context: StrategyContext = {
    sourceFile: filePath,
    code,
    ast,
    findings: result.diagnostics,
    contracts,
    functionSummaries: [],
    framework: options.framework,
    projectRoot: options.outputDir || '.',
  };

  const strategies = getAllStrategies();
  const testCases: TestCase[] = [];

  for (const finding of result.diagnostics) {
    if (options.ruleFilter && !options.ruleFilter.includes(finding.ruleId)) continue;
    const strategy = strategies.find(s => s.handlesRules.includes(finding.ruleId));
    if (strategy) {
      testCases.push(...strategy.generate(context, finding));
    }
  }

  // 6. Generate the test file
  const content = generateTestFile(testCases, options.framework, filePath);

  return {
    filePath: filePath.replace(/\.(tsx?|jsx?)$/, '.test.$1'),
    content,
    framework: options.framework,
    testCases,
    sourceFile: filePath,
  };
}
```

---

## 8. CLI Integration (`src/cli.ts`)

### New flags

```bash
# Generate tests from static analysis
code-verifier --generate-tests ./src/ --output ./tests/

# Generate tests for a specific rule
code-verifier --generate-tests ./src/ --rule AI-NULL-001

# Specify framework (override auto-detection)
code-verifier --generate-tests ./src/ --framework vitest

# Write tests next to source files
code-verifier --generate-tests ./src/ --in-place
```

### CLI implementation

```typescript
// In src/cli.ts, add to arg parsing:
if (args['generate-tests']) {
  const target = args['generate-tests'];
  const outputDir = args['output'] || '.verifier/tests';
  const framework = args['framework'] as TestFramework | undefined;
  const ruleFilter = args['rule'] ? [args['rule']] : undefined;
  const mode: OutputMode = args['in-place'] ? 'in-place' : 'directory';

  const files = expandTargets([target]);
  const results = await generateTests(files, {
    framework,
    outputDir,
    mode,
    ruleFilter,
    includeSetup: true,
  });

  for (const result of results) {
    if (mode === 'in-place') {
      fs.writeFileSync(result.filePath, result.content);
    } else {
      const outputPath = path.join(outputDir, path.basename(result.filePath));
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, result.content);
    }
  }

  console.log(`Generated ${results.length} test files`);
  process.exit(0);
}
```

---

## 9. MCP Integration (`src/mcp-server.ts`)

### New tool

```typescript
// tools/list returns:
{
  name: "generate_tests",
  description: "Generate test suite from static analysis. Returns test file content.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Source file to generate tests for" },
      framework: { type: "string", enum: ["jest", "vitest", "detox"], description: "Test framework (auto-detected if not specified)" },
      ruleFilter: { type: "array", items: { type: "string" }, description: "Only generate tests for these rule IDs" },
    },
    required: ["filePath"],
  },
}

// tools/call handles:
if (toolName === 'generate_tests') {
  const { filePath, framework, ruleFilter } = params;
  const result = generateTestsForFile(filePath, {
    framework: framework as TestFramework | undefined,
    mode: 'directory',
    ruleFilter,
    includeSetup: true,
  });
  return {
    content: [{ type: 'text', text: result.content }],
    isError: false,
  };
}
```

---

## 10. Acceptance Criteria

Phase 2A is complete when:

1. **Mock synthesizer works:** Given a file with `import { useNavigation } from '@react-navigation/native'`, the generated test includes the correct `jest.mock()` call.

2. **Nullability tests generated:** Given a file with an `AI-NULL-001` finding, the generator produces a test that calls the function with `null` and asserts the result is defined.

3. **Component contract tests generated:** Given a file with a `COMP-001` finding and a component contract, the generator produces a render test with all required props.

4. **Framework auto-detection works:** Given a project with `vitest` in `devDependencies`, the generator uses `vi.mock` instead of `jest.mock`.

5. **CLI works end-to-end:** `code-verifier --generate-tests ./samples/ --output /tmp/test-output/` produces test files in `/tmp/test-output/`.

6. **MCP tool works:** Calling `generate_tests` via MCP returns test file content.

7. **Generated tests are syntactically valid:** All generated test files parse without errors (can be checked with `tsc --noEmit` or `npx jest --listTests`).

---

## 11. Implementation Order

1. `src/test-gen/types.ts` — Type definitions
2. `src/test-gen/mock-synthesizer.ts` — Import inspection and mock generation
3. `src/test-gen/templates.ts` — Test file templates
4. `src/test-gen/strategies.ts` — Test generation strategies (start with NullabilityStrategy and ComponentContractStrategy)
5. `src/test-gen/frameworks/jest.ts` — Jest generator
6. `src/test-gen/frameworks/vitest.ts` — Vitest generator
7. `src/test-gen/generator.ts` — Main orchestrator
8. `src/cli.ts` — CLI integration
9. `src/mcp-server.ts` — MCP integration

---

## 12. Review Checklist

After implementation, verify:

- [ ] All new files compile with `tsc`
- [ ] `npm test` still passes (existing tests not broken)
- [ ] `code-verifier --generate-tests ./samples/ --output /tmp/test-output/` produces test files
- [ ] Generated test files are syntactically valid
- [ ] Mock synthesizer handles all well-known packages
- [ ] Framework auto-detection works for Jest and Vitest projects
- [ ] MCP `generate_tests` tool returns test content
- [ ] CLI `--generate-tests` flag works end-to-end
