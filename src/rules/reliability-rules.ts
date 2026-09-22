import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";

function emit(
  ctx: RuleContext,
  node: t.Node,
  ruleId: string,
  category: "CORRECTNESS" | "PERFORMANCE",
  severity: "HIGH" | "MEDIUM" | "LOW",
  message: string,
  explanation: string,
  remediation: string,
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    category,
    severity,
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

export const EmptyCatchRule: VerificationRule = {
  id: "REL-001",
  name: "Empty Catch Block",
  description: "Detects exceptions silently discarded by empty catch blocks.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CatchClause(path) {
        if (path.node.body.body.length > 0) return;
        const start = path.node.body.loc?.start.line ?? 1;
        const end = path.node.body.loc?.end.line ?? start;
        const bodyText = ctx.lines.slice(start - 1, end).join("\n");
        if (
          /\b(?:ignore(?:d)?|intentional(?:ly)?|best[- ]effort|graceful fallback|optional)\b/i.test(
            bodyText,
          )
        )
          return;
        emit(
          ctx,
          path.node,
          "REL-001",
          "CORRECTNESS",
          "MEDIUM",
          "An exception is silently discarded by an empty catch block.",
          "The operation can fail without telemetry, recovery, or propagation, leaving callers to continue with invalid assumptions.",
          "Handle the expected failure explicitly, add useful context and rethrow, or document a narrowly intentional ignore.",
        );
      },
    });
  },
};

export const FinallyControlFlowRule: VerificationRule = {
  id: "REL-002",
  name: "Control Flow in Finally",
  description:
    "Detects return, throw, break, or continue statements that override completion from try/catch.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      TryStatement(path) {
        const finalizer = path.get("finalizer");
        if (!finalizer.node) return;
        finalizer.traverse({
          Function(inner) {
            inner.skip();
          },
          "ReturnStatement|ThrowStatement|BreakStatement|ContinueStatement"(
            flowPath,
          ) {
            emit(
              ctx,
              flowPath.node,
              "REL-002",
              "CORRECTNESS",
              "HIGH",
              "Control flow in finally overrides the pending result or error.",
              "A completion from finally replaces a return value or exception produced by the try or catch block.",
              "Keep finally limited to cleanup; return or throw after the try statement instead.",
            );
          },
        });
      },
    });
  },
};

export const UnreachableStatementRule: VerificationRule = {
  id: "LOGIC-003",
  name: "Unreachable Statement",
  description:
    "Detects statements following unconditional control-flow termination in the same block.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      BlockStatement(path) {
        let terminated = false;
        for (const statement of path.node.body) {
          if (terminated && !t.isFunctionDeclaration(statement)) {
            emit(
              ctx,
              statement,
              "LOGIC-003",
              "CORRECTNESS",
              "MEDIUM",
              "This statement is unreachable.",
              "A preceding return, throw, break, or continue always transfers control away from this block.",
              "Remove the dead statement or correct the preceding control flow.",
            );
            break;
          }
          terminated =
            t.isReturnStatement(statement) ||
            t.isThrowStatement(statement) ||
            t.isBreakStatement(statement) ||
            t.isContinueStatement(statement);
        }
      },
    });
  },
};

export const IgnoredMapResultRule: VerificationRule = {
  id: "QUAL-001",
  name: "Ignored map Result",
  description: "Detects map calls used solely as expression statements.",
  category: "PERFORMANCE",
  defaultSeverity: "LOW",
  check(ctx) {
    traverse(ctx.ast, {
      ExpressionStatement(path) {
        const expression = path.node.expression;
        if (
          !t.isCallExpression(expression) ||
          !t.isMemberExpression(expression.callee) ||
          !t.isIdentifier(expression.callee.property, { name: "map" })
        )
          return;
        emit(
          ctx,
          expression,
          "QUAL-001",
          "PERFORMANCE",
          "LOW",
          "The array returned by map() is ignored.",
          "map allocates a new array for transformed values; ignoring it usually means forEach was intended or a result was accidentally dropped.",
          "Use forEach for side effects, or assign/return the transformed array.",
        );
      },
    });
  },
};

export const RELIABILITY_RULES: VerificationRule[] = [
  EmptyCatchRule,
  FinallyControlFlowRule,
  UnreachableStatementRule,
  IgnoredMapResultRule,
];
