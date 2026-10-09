import { Diagnostic } from "../types/verifier";
import { ComponentContractFact } from "../project-ui-index";
import { FunctionSummary } from "../abstract-interpreter/function-summaries";

/** Supported test frameworks */
export type TestFramework = "jest" | "vitest" | "detox";

/** Output mode for generated tests */
export type OutputMode = "directory" | "in-place";

/** A mock specification */
export interface MockSpec {
  /** The module to mock (e.g. '@react-navigation/native') */
  module: string;
  /** The mock factory code */
  factory: string;
  /** Whether this is a default export mock */
  isDefault: boolean;
}

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

/** Result of test generation for a single file */
export interface GeneratedTest {
  /** The test file path (relative to output dir or in-place) */
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
  mode?: OutputMode;
  /** Specific rule IDs to generate tests for (empty = all) */
  ruleFilter?: string[];
  /** Whether to include setup files (jest-setup, etc.) */
  includeSetup?: boolean;
  /** Project root directory for dependency discovery */
  projectRoot?: string;
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
  findings: Diagnostic[];
  /** Component contracts from ProjectUiIndex */
  contracts: ComponentContractFact[];
  /** Function summaries */
  functionSummaries: FunctionSummary[];
  /** The target framework */
  framework: TestFramework;
  /** The project root */
  projectRoot: string;
}
