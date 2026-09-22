import { VerificationRule } from "../types/verifier";

// Execution lives in SemanticAnalysisIndex because these rules require one shared TypeScript Program.
export const SEMANTIC_RULES: VerificationRule[] = [
  {
    id: "TYPE-001",
    name: "Floating Promise",
    description:
      "Detects typed Promise expressions that are not awaited, returned, voided, or rejection-handled.",
    category: "CORRECTNESS",
    defaultSeverity: "MEDIUM",
    check() {},
  },
  {
    id: "TYPE-002",
    name: "Promise Used as Condition",
    description: "Detects Promise values used directly as boolean conditions.",
    category: "CORRECTNESS",
    defaultSeverity: "HIGH",
    check() {},
  },
];
