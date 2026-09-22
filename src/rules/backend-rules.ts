import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";

function chain(node: t.Node): string {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && t.isIdentifier(node.property))
    return `${chain(node.object)}.${node.property.name}`;
  if (t.isCallExpression(node)) return chain(node.callee);
  return "";
}

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
    category: ruleId.startsWith("AUTH-") ? "SECURITY" : "CORRECTNESS",
    severity,
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

export const ErrorDetailLeakRule: VerificationRule = {
  id: "API-001",
  name: "Internal Error Detail in Response",
  description:
    "Detects error stacks and raw exception messages returned in HTTP responses.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-209",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const name = chain(path.node.callee);
        if (!/\.(?:json|send)$/.test(name)) return;
        const payload = path.node.arguments[0];
        if (!t.isExpression(payload)) return;
        let leaks = false;
        path.get("arguments.0").traverse({
          MemberExpression(memberPath) {
            if (
              t.isIdentifier(memberPath.node.property) &&
              ["stack", "message"].includes(memberPath.node.property.name) &&
              t.isIdentifier(memberPath.node.object) &&
              /err|error|exception/i.test(memberPath.node.object.name)
            )
              leaks = true;
          },
        });
        if (!leaks) return;
        emit(
          ctx,
          path.node,
          "API-001",
          "HIGH",
          "HTTP response exposes raw internal error details.",
          "Exception messages and stacks can disclose paths, queries, dependencies, and implementation details.",
          "Return a stable public error code/message and log sanitized technical details server-side.",
        );
      },
    });
  },
};

export const ErrorWithSuccessStatusRule: VerificationRule = {
  id: "API-002",
  name: "Error Payload with Success Status",
  description:
    "Detects error responses explicitly returned with an HTTP 2xx status.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (!/\.json$/.test(chain(path.node.callee))) return;
        const callee = path.node.callee;
        if (
          !t.isMemberExpression(callee) ||
          !t.isCallExpression(callee.object) ||
          !t.isMemberExpression(callee.object.callee) ||
          !t.isIdentifier(callee.object.callee.property, { name: "status" })
        )
          return;
        const status = callee.object.arguments[0];
        if (
          !t.isNumericLiteral(status) ||
          status.value < 200 ||
          status.value >= 300
        )
          return;
        const payload = path.node.arguments[0];
        if (
          !t.isObjectExpression(payload) ||
          !payload.properties.some(
            (property) =>
              t.isObjectProperty(property) &&
              ((t.isIdentifier(property.key) &&
                ["error", "errors"].includes(property.key.name)) ||
                (t.isStringLiteral(property.key) &&
                  ["error", "errors"].includes(property.key.value))),
          )
        )
          return;
        emit(
          ctx,
          path.node,
          "API-002",
          "MEDIUM",
          `Error payload is returned with success status ${status.value}.`,
          "Clients, caches, monitoring, and retries rely on HTTP status semantics and may treat this failure as success.",
          "Return the semantically appropriate 4xx or 5xx status code.",
        );
      },
    });
  },
};

export const MissingReturnAfterResponseRule: VerificationRule = {
  id: "API-003",
  name: "Execution Continues After Conditional Response",
  description:
    "Detects conditional Express responses without return followed by another response.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      IfStatement(path) {
        if (
          t.isReturnStatement(path.node.consequent) ||
          (t.isBlockStatement(path.node.consequent) &&
            path.node.consequent.body.some(t.isReturnStatement))
        )
          return;
        let sends = false;
        path.get("consequent").traverse({
          CallExpression(callPath) {
            if (
              /\.(?:json|send|end|redirect)$/.test(chain(callPath.node.callee))
            )
              sends = true;
          },
        });
        if (!sends) return;
        const parent = path.parentPath;
        if (!parent.isBlockStatement()) return;
        const index = parent.node.body.indexOf(path.node);
        const later = parent.node.body.slice(index + 1).some((statement) => {
          let found = false;
          traverse(t.file(t.program([statement])), {
            CallExpression(callPath) {
              if (
                /\.(?:json|send|end|redirect)$/.test(
                  chain(callPath.node.callee),
                )
              )
                found = true;
            },
          });
          return found;
        });
        if (!later) return;
        emit(
          ctx,
          path.node,
          "API-003",
          "HIGH",
          "Execution can continue after sending a conditional HTTP response.",
          "The handler may send a second response or perform state-changing work after an error response.",
          "Return the response or add an explicit return immediately after sending it.",
        );
      },
    });
  },
};

export const UnprotectedAdminRouteRule: VerificationRule = {
  id: "AUTH-001",
  name: "Unprotected Administrative Route",
  description:
    "Detects explicit admin route paths with no middleware before the handler.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-862",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (
          !t.isMemberExpression(callee) ||
          !t.isIdentifier(callee.property) ||
          !["get", "post", "put", "patch", "delete"].includes(
            callee.property.name,
          )
        )
          return;
        const route = path.node.arguments[0];
        if (
          !t.isStringLiteral(route) ||
          !/(?:^|\/)admin(?:\/|$)/i.test(route.value)
        )
          return;
        if (path.node.arguments.length !== 2) return;
        const handler = path.node.arguments[1];
        if (
          !t.isFunctionExpression(handler) &&
          !t.isArrowFunctionExpression(handler)
        )
          return;
        emit(
          ctx,
          path.node,
          "AUTH-001",
          "HIGH",
          `Administrative route '${route.value}' has no authorization middleware.`,
          "Authentication inside a handler is easy to omit or bypass; administrative routes need explicit access control.",
          "Insert tested authentication and role/permission middleware before the route handler.",
        );
      },
    });
  },
};

export const BACKEND_RULES: VerificationRule[] = [
  ErrorDetailLeakRule,
  ErrorWithSuccessStatusRule,
  MissingReturnAfterResponseRule,
  UnprotectedAdminRouteRule,
];
