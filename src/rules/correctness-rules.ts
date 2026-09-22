import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";

function emit(
  ctx: RuleContext,
  node: t.Node,
  ruleId: string,
  severity: "HIGH" | "MEDIUM",
  message: string,
  explanation: string,
  remediation: string,
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    category: "CORRECTNESS",
    severity,
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

function methodName(call: t.CallExpression): string | null {
  const callee = call.callee;
  return t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property)
    ? callee.property.name
    : null;
}

function functionHasOwnReturn(
  path: NodePath<t.FunctionExpression | t.ArrowFunctionExpression>,
): boolean {
  if (!t.isBlockStatement(path.node.body)) return true;
  let found = false;
  path.get("body").traverse({
    Function(inner) {
      inner.skip();
    },
    ReturnStatement(returnPath) {
      found = true;
      returnPath.stop();
    },
  });
  return found;
}

export const AssignmentInConditionRule: VerificationRule = {
  id: "LOGIC-001",
  name: "Assignment in Conditional",
  description:
    "Detects assignment expressions used as branch or loop conditions.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      AssignmentExpression(path) {
        const parent = path.parentPath;
        const isCondition =
          (parent.isIfStatement() ||
            parent.isWhileStatement() ||
            parent.isDoWhileStatement() ||
            parent.isForStatement() ||
            parent.isConditionalExpression()) &&
          parent.node.test === path.node;
        if (!isCondition) return;
        emit(
          ctx,
          path.node,
          "LOGIC-001",
          "HIGH",
          "An assignment is used as a conditional expression.",
          "A single equals sign in a condition is frequently a typo that mutates state and evaluates the assigned value.",
          "Use a comparison operator, or move the intentional assignment to a separate statement.",
        );
      },
    });
  },
};

export const MissingArrayCallbackReturnRule: VerificationRule = {
  id: "LOGIC-002",
  name: "Missing Array Callback Return",
  description:
    "Detects value-producing array callbacks with block bodies that never return a value.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (
          ![
            "map",
            "filter",
            "find",
            "findIndex",
            "some",
            "every",
            "reduce",
          ].includes(methodName(path.node) ?? "")
        )
          return;
        const callbackPath = path.get("arguments.0");
        if (
          !callbackPath.isArrowFunctionExpression() &&
          !callbackPath.isFunctionExpression()
        )
          return;
        if (
          !t.isBlockStatement(callbackPath.node.body) ||
          functionHasOwnReturn(callbackPath)
        )
          return;
        emit(
          ctx,
          callbackPath.node,
          "LOGIC-002",
          "HIGH",
          `The ${methodName(path.node)} callback has a block body but never returns a value.`,
          "This callback produces undefined for every element, which usually breaks filtering, searching, reduction, or mapping.",
          "Return the intended value from every reachable callback path, or use forEach for side effects.",
        );
      },
    });
  },
};

export const AsyncForEachRule: VerificationRule = {
  id: "ASYNC-001",
  name: "Async forEach Callback",
  description:
    "Detects async callbacks passed to forEach, which does not await returned promises.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (methodName(path.node) !== "forEach") return;
        const callback = path.node.arguments[0];
        if (
          (!t.isArrowFunctionExpression(callback) &&
            !t.isFunctionExpression(callback)) ||
          !callback.async
        )
          return;
        emit(
          ctx,
          path.node,
          "ASYNC-001",
          "HIGH",
          "forEach receives an async callback that it will not await.",
          "The outer flow continues immediately and callback rejections may become unhandled.",
          "Use for...of with await for sequential work, or await Promise.all(items.map(async ...)) for concurrent work.",
        );
      },
    });
  },
};

export const AsyncPromiseExecutorRule: VerificationRule = {
  id: "ASYNC-002",
  name: "Async Promise Executor",
  description: "Detects async functions passed to the Promise constructor.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      NewExpression(path) {
        if (!t.isIdentifier(path.node.callee, { name: "Promise" })) return;
        const executor = path.node.arguments[0];
        if (
          (!t.isArrowFunctionExpression(executor) &&
            !t.isFunctionExpression(executor)) ||
          !executor.async
        )
          return;
        emit(
          ctx,
          path.node,
          "ASYNC-002",
          "HIGH",
          "Promise is constructed with an async executor.",
          "Exceptions after an await reject the executor promise rather than the outer constructed promise, which can leave it pending.",
          "Remove the Promise constructor and return the async operation directly, or use a synchronous executor.",
        );
      },
    });
  },
};

export const CORRECTNESS_RULES: VerificationRule[] = [
  AssignmentInConditionRule,
  MissingArrayCallbackReturnRule,
  AsyncForEachRule,
  AsyncPromiseExecutorRule,
];
