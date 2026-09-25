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
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    category: "CORRECTNESS",
    severity: "HIGH",
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

export const LOGIC_ANALYSIS_RULES: VerificationRule[] = [NullableArithmeticRule];
