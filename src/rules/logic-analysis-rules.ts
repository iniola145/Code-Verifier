import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";

function emit(
  ctx: RuleContext,
  node: t.Node,
  ruleId: string,
  message: string,
  explanation: string,
  remediation: string,
  category: "CORRECTNESS" | "REACT_HOOKS" = "CORRECTNESS",
  severity: "HIGH" | "MEDIUM" = "HIGH",
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

function typeContainsNullish(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const typed = node as Record<string, unknown> & { type?: string };
  if (typed.type === "TSNullKeyword" || typed.type === "TSUndefinedKeyword")
    return true;
  return Object.entries(typed).some(
    ([key, value]) =>
      key !== "loc" &&
      key !== "start" &&
      key !== "end" &&
      (Array.isArray(value)
        ? value.some(typeContainsNullish)
        : typeContainsNullish(value)),
  );
}

function identifierCanBeNullish(path: NodePath<t.Identifier>): boolean {
  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return false;
  const bindingPath = binding.path;
  if (bindingPath.isVariableDeclarator() && t.isArrayPattern(bindingPath.node.id)) {
    const stateName = bindingPath.node.id.elements[0];
    if (!t.isIdentifier(stateName, { name: path.node.name })) return false;
    const init = bindingPath.node.init;
    if (t.isCallExpression(init)) {
      const callee = init.callee;
      const isUseState =
        t.isIdentifier(callee, { name: "useState" }) ||
        (t.isMemberExpression(callee) &&
          t.isIdentifier(callee.property, { name: "useState" }));
      const params = init.typeParameters ?? init.typeArguments;
      if (isUseState && params && typeContainsNullish(params)) return true;
    }
  }
  if (bindingPath.isIdentifier()) {
    if (typeContainsNullish(bindingPath.node.typeAnnotation)) return true;
    const parent = bindingPath.parentPath;
    if (parent?.isArrayPattern() && parent.parentPath?.isVariableDeclarator()) {
      const init = parent.parentPath.node.init;
      if (t.isCallExpression(init)) {
        const callee = init.callee;
        const isUseState =
          t.isIdentifier(callee, { name: "useState" }) ||
          (t.isMemberExpression(callee) &&
            t.isIdentifier(callee.property, { name: "useState" }));
        const params = init.typeParameters ?? init.typeArguments;
        if (isUseState && params && typeContainsNullish(params)) return true;
      }
    }
  }
  return false;
}

function isNullishGuarded(path: NodePath<t.Identifier>): boolean {
  const guardedByAncestor = !!path.findParent((parent) => {
    if (!parent.isIfStatement()) return false;
    const test = parent.node.test;
    const name = path.node.name;
    return (
      (t.isIdentifier(test, { name }) && parent.get("consequent").isAncestor(path)) ||
      (t.isBinaryExpression(test) &&
        ["!=", "!=="].includes(test.operator) &&
        t.isIdentifier(test.left, { name }) &&
        (t.isNullLiteral(test.right) || t.isIdentifier(test.right, { name: "undefined" })) &&
        parent.get("consequent").isAncestor(path))
    );
  });
  if (guardedByAncestor) return true;

  const statement = path.getStatementParent();
  if (!statement?.parentPath?.isBlockStatement()) return false;
  const name = path.node.name;
  for (const sibling of statement.getAllPrevSiblings()) {
    if (!sibling.isIfStatement()) continue;
    const test = sibling.node.test;
    const consequent = sibling.node.consequent;
    const exits = t.isReturnStatement(consequent) ||
      (t.isBlockStatement(consequent) && consequent.body.some((s) => t.isReturnStatement(s) || t.isThrowStatement(s)));
    if (!exits || !t.isBinaryExpression(test)) continue;
    if (
      ["==", "==="].includes(test.operator) &&
      t.isIdentifier(test.left, { name }) &&
      (t.isNullLiteral(test.right) || t.isIdentifier(test.right, { name: "undefined" }))
    ) return true;
  }
  return false;
}

export const NullableArithmeticRule: VerificationRule = {
  id: "LOGIC-004",
  name: "Nullable Arithmetic Operand",
  description:
    "Detects arithmetic performed on values whose declared type includes null or undefined.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      BinaryExpression(path) {
        if (!["+", "-", "*", "/", "%", "**"].includes(path.node.operator))
          return;
        for (const side of [path.get("left"), path.get("right")]) {
          if (!side.isIdentifier()) continue;
          if (!identifierCanBeNullish(side) || isNullishGuarded(side)) continue;
          emit(
            ctx,
            side.node,
            "LOGIC-004",
            `Arithmetic uses nullable value '${side.node.name}'.`,
            "JavaScript silently coerces null to zero and undefined to NaN, producing plausible but incorrect numeric output.",
            `Guard '${side.node.name}' against null/undefined or provide an explicit numeric fallback before arithmetic.`,
          );
        }
      },
    });
  },
};

function resolvesToNumericLiteral(path: NodePath<t.Expression>): number | null {
  if (path.isNumericLiteral()) return path.node.value;
  if (!path.isIdentifier()) return null;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding?.constant || !binding.path.isVariableDeclarator()) return null;
  const init = binding.path.get("init");
  return init.isNumericLiteral() ? init.node.value : null;
}

export const DefiniteZeroDivisionRule: VerificationRule = {
  id: "LOGIC-005",
  name: "Definite Division by Zero",
  description: "Detects division or remainder operations whose divisor is provably zero.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      BinaryExpression(path) {
        if (!["/", "%"].includes(path.node.operator)) return;
        const right = path.get("right");
        if (!right.isExpression() || resolvesToNumericLiteral(right) !== 0) return;
        emit(
          ctx,
          right.node,
          "LOGIC-005",
          `The '${path.node.operator}' operation has a divisor of zero.`,
          path.node.operator === "/"
            ? "JavaScript returns Infinity or -Infinity instead of throwing, allowing an invalid number to spread through later calculations."
            : "Remainder by zero evaluates to NaN and contaminates subsequent calculations.",
          "Ensure the divisor is non-zero before performing the operation.",
        );
      },
    });
  },
};

function isUncheckedNumericParse(node: t.Node): boolean {
  if (!t.isCallExpression(node)) return false;
  const callee = node.callee;
  return (
    (t.isIdentifier(callee) && ["parseInt", "parseFloat", "Number"].includes(callee.name)) ||
    (t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object, { name: "Number" }) &&
      t.isIdentifier(callee.property) &&
      ["parseInt", "parseFloat"].includes(callee.property.name))
  );
}

export const UncheckedNumericParseRule: VerificationRule = {
  id: "LOGIC-006",
  name: "Unchecked Numeric Parse",
  description: "Detects numeric parsing used directly in arithmetic without a NaN fallback.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      BinaryExpression(path) {
        if (!["+", "-", "*", "/", "%", "**"].includes(path.node.operator)) return;
        for (const operand of [path.node.left, path.node.right]) {
          if (!isUncheckedNumericParse(operand)) continue;
          emit(
            ctx,
            operand,
            "LOGIC-006",
            "A parsed number is used in arithmetic without validating NaN.",
            "Numeric parsing can return NaN for empty, malformed, or partially validated input, and NaN silently propagates through calculations.",
            "Validate the parsed result with Number.isFinite/Number.isNaN, or provide an explicit fallback before arithmetic.",
          );
        }
      },
    });
  },
};

export const InvalidNaNComparisonRule: VerificationRule = {
  id: "LOGIC-007",
  name: "Invalid NaN Comparison",
  description: "Detects equality comparisons with NaN, which can never succeed.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      BinaryExpression(path) {
        if (!["==", "===", "!=", "!=="].includes(path.node.operator)) return;
        const hasNaN =
          t.isIdentifier(path.node.left, { name: "NaN" }) ||
          t.isIdentifier(path.node.right, { name: "NaN" });
        if (!hasNaN) return;
        emit(
          ctx,
          path.node,
          "LOGIC-007",
          "NaN is compared using an equality operator.",
          "NaN is unequal to every value, including itself, so this comparison is constant and cannot validate numeric input.",
          "Use Number.isNaN(value), or Number.isFinite(value) when infinities are also invalid.",
        );
      },
    });
  },
};

function isNullableStateWithNonNullInitial(path: NodePath<t.Identifier>): boolean {
  const binding = path.scope.getBinding(path.node.name);
  if (!binding?.path.isVariableDeclarator() || !t.isArrayPattern(binding.path.node.id))
    return false;
  const init = binding.path.node.init;
  if (!t.isCallExpression(init)) return false;
  const callee = init.callee;
  const isUseState =
    t.isIdentifier(callee, { name: "useState" }) ||
    (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: "useState" }));
  const params = init.typeParameters ?? init.typeArguments;
  const initial = init.arguments[0];
  return !!(
    isUseState &&
    params &&
    typeContainsNullish(params) &&
    initial &&
    !t.isNullLiteral(initial) &&
    !t.isIdentifier(initial, { name: "undefined" })
  );
}

export const NullableStateLifecycleRule: VerificationRule = {
  id: "REACT-021",
  name: "Nullable State Lifecycle Dereference",
  description:
    "Detects state declared nullable but dereferenced as if its non-null initial value persisted across renders.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      MemberExpression(path) {
        if (path.node.optional || !t.isIdentifier(path.node.object)) return;
        const object = path.get("object");
        if (!object.isIdentifier()) return;
        if (!isNullableStateWithNonNullInitial(object) || isNullishGuarded(object)) return;
        emit(
          ctx,
          path.node,
          "REACT-021",
          `Nullable state '${object.node.name}' is dereferenced without a render-time guard.`,
          "A later state update can replace the non-null initial value with null or undefined on a subsequent render.",
          `Guard '${object.node.name}' in the render that uses it, use optional chaining, or make the state type non-nullable.`,
          "REACT_HOOKS",
          "MEDIUM",
        );
      },
    });
  },
};

export const LOGIC_ANALYSIS_RULES: VerificationRule[] = [
  NullableArithmeticRule,
  DefiniteZeroDivisionRule,
  UncheckedNumericParseRule,
  InvalidNaNComparisonRule,
  NullableStateLifecycleRule,
];
