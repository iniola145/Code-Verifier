"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEMANTIC_RULES = void 0;
// Execution lives in SemanticAnalysisIndex because these rules require one shared TypeScript Program.
exports.SEMANTIC_RULES = [
    {
        id: "TYPE-001",
        name: "Floating Promise",
        description: "Detects typed Promise expressions that are not awaited, returned, voided, or rejection-handled.",
        category: "CORRECTNESS",
        defaultSeverity: "MEDIUM",
        check() { },
    },
    {
        id: "TYPE-002",
        name: "Promise Used as Condition",
        description: "Detects Promise values used directly as boolean conditions.",
        category: "CORRECTNESS",
        defaultSeverity: "HIGH",
        check() { },
    },
];
