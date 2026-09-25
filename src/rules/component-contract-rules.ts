import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";

function report(
  ctx: RuleContext,
  node: t.Node,
  ruleId: string,
  message: string,
  explanation: string,
  remediation: string,
  trace: Record<string, string>,
  severity: "MEDIUM" | "LOW" = "MEDIUM",
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
    abstractInvariants: trace,
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

function jsxName(node: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string | null {
  return t.isJSXIdentifier(node) ? node.name : null;
}

export const MissingRequiredComponentPropRule: VerificationRule = {
  id: "COMP-001",
  name: "Missing Required Component Prop",
  description: "Detects imported components rendered without props required by their exported contract.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    if (ctx.projectComponentContracts.size === 0) return;
    traverse(ctx.ast, {
      JSXOpeningElement(path) {
        const name = jsxName(path.node.name);
        const contract = name ? ctx.projectComponentContracts.get(name) : undefined;
        if (!name || !contract || path.node.attributes.some(t.isJSXSpreadAttribute)) return;
        const provided = new Set(path.node.attributes.flatMap((attribute) =>
          t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name) ? [attribute.name.name] : []));
        if (!path.node.selfClosing && path.parentPath.isJSXElement() && path.parentPath.node.children.some((child) =>
          !t.isJSXText(child) || child.value.trim().length > 0)) provided.add("children");
        const missing = [...contract.props].filter(([prop, fact]) => fact.required && !provided.has(prop)).map(([prop]) => prop);
        if (missing.length === 0) return;
        report(ctx, path.node, "COMP-001", `${name} is missing required prop${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
          "The child contract requires these values, so rendering without them can produce undefined callbacks, blank state, or a crash.",
          `Pass ${missing.join(", ")} or make the prop optional with a safe default in ${name}.`, {
            "1.contract": `${contract.sourceFile} exports ${contract.exportName}`,
            "2.required": missing.join(", "),
            "3.consumer": ctx.filePath,
            "4.render": `<${name}> omits the required contract field(s)`,
          });
      },
    });
  },
};

function isAsyncValue(path: any): boolean {
  if (path.isArrowFunctionExpression() || path.isFunctionExpression()) return path.node.async;
  if (!path.isIdentifier()) return false;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return false;
  if (binding.path.isFunctionDeclaration()) return binding.path.node.async;
  if (binding.path.isVariableDeclarator()) {
    const init = binding.path.get("init");
    return (init.isArrowFunctionExpression() || init.isFunctionExpression()) && init.node.async;
  }
  return false;
}

export const AsyncCallbackToSyncPropRule: VerificationRule = {
  id: "COMP-002",
  name: "Promise Discarded by Component Callback Contract",
  description: "Advises when an async callback is passed to a component contract that does not expose Promise completion.",
  category: "CORRECTNESS",
  defaultSeverity: "LOW",
  check(ctx) {
    traverse(ctx.ast, {
      JSXOpeningElement(path) {
        const name = jsxName(path.node.name);
        const contract = name ? ctx.projectComponentContracts.get(name) : undefined;
        if (!name || !contract) return;
        for (const attributePath of path.get("attributes")) {
          if (!attributePath.isJSXAttribute() || !t.isJSXIdentifier(attributePath.node.name) ||
            !t.isJSXExpressionContainer(attributePath.node.value)) continue;
          const prop = attributePath.node.name.name;
          const fact = contract.props.get(prop);
          if (fact?.callbackReturnsPromise !== false) continue;
          const expression = attributePath.get("value.expression");
          if (!isAsyncValue(expression)) continue;
          report(ctx, attributePath.node, "COMP-002", `Promise completion is hidden by prop '${prop}' on ${name}.`,
            "This is legal for void-returning callbacks and may be intentional, but the child contract cannot await completion or observe rejection. It can therefore close UI or report success while work is still pending.",
            `Change ${prop}'s contract to return Promise and await it, or handle errors entirely inside the callback.`, {
              "1.contract": `${contract.sourceFile}: ${contract.exportName}.${prop} returns synchronously`,
              "2.consumer": ctx.filePath,
              "3.value": "async callback returns Promise",
              "4.mismatch": "Promise is discarded by a synchronous component contract",
            }, "LOW");
        }
      },
    });
  },
};

export const ExplicitNullComponentPropRule: VerificationRule = {
  id: "COMP-003",
  name: "Null Passed to Non-Nullable Component Prop",
  description: "Detects explicit null or undefined values passed to non-nullable imported component props.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      JSXOpeningElement(path) {
        const name = jsxName(path.node.name);
        const contract = name ? ctx.projectComponentContracts.get(name) : undefined;
        if (!name || !contract) return;
        for (const attribute of path.node.attributes) {
          if (!t.isJSXAttribute(attribute) || !t.isJSXIdentifier(attribute.name) || !t.isJSXExpressionContainer(attribute.value)) continue;
          const fact = contract.props.get(attribute.name.name);
          if (!fact || fact.allowsNullish) continue;
          const value = attribute.value.expression;
          if (!(t.isNullLiteral(value) || t.isIdentifier(value, { name: "undefined" }))) continue;
          report(ctx, attribute, "COMP-003", `Non-nullable prop '${attribute.name.name}' on ${name} receives ${t.isNullLiteral(value) ? "null" : "undefined"}.`,
            "The child contract permits no absent value and may dereference or render it directly.",
            "Provide a valid value, guard the render, or explicitly make the child prop nullable and handle that state.", {
              "1.contract": `${contract.sourceFile}: ${contract.exportName}.${attribute.name.name} is non-nullable`,
              "2.consumer": ctx.filePath,
              "3.value": t.isNullLiteral(value) ? "null" : "undefined",
            });
        }
      },
    });
  },
};

export const UncontrolledStateValueRule: VerificationRule = {
  id: "COMP-004",
  name: "Potential Controlled-to-Uncontrolled Input",
  description: "Detects state initialized as undefined and passed directly to an input value prop.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    const undefinedState = new Set<string>();
    traverse(ctx.ast, {
      VariableDeclarator(path) {
        if (!t.isArrayPattern(path.node.id) || !t.isIdentifier(path.node.id.elements[0]) || !t.isCallExpression(path.node.init) || path.node.init.arguments.length > 0) return;
        const callee = path.node.init.callee;
        if (t.isIdentifier(callee, { name: "useState" }) || t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: "useState" }))
          undefinedState.add(path.node.id.elements[0].name);
      },
      JSXAttribute(path) {
        if (!t.isJSXIdentifier(path.node.name, { name: "value" }) || !t.isJSXExpressionContainer(path.node.value) ||
          !t.isIdentifier(path.node.value.expression) || !undefinedState.has(path.node.value.expression.name)) return;
        const opening = path.parentPath;
        if (!opening.isJSXOpeningElement() || !t.isJSXIdentifier(opening.node.name) || !["input", "textarea", "select"].includes(opening.node.name.name)) return;
        report(ctx, path.node, "COMP-004", `Input value '${path.node.value.expression.name}' starts as undefined.`,
          "The element begins uncontrolled and becomes controlled after the first state update, which can lose edits and produces a React runtime warning.",
          `Initialize ${path.node.value.expression.name} with an empty string or pass ${path.node.value.expression.name} ?? ''.`, {
            "1.state": `useState() initializes ${path.node.value.expression.name} as undefined`,
            "2.render": `${opening.node.name.name}.value receives that state directly`,
            "3.transition": "a later setter call can switch the input to controlled",
          });
      },
    });
  },
};

export const COMPONENT_CONTRACT_RULES: VerificationRule[] = [
  MissingRequiredComponentPropRule,
  AsyncCallbackToSyncPropRule,
  ExplicitNullComponentPropRule,
  UncontrolledStateValueRule,
];
