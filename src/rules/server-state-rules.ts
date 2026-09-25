import traverse, { NodePath } from "@babel/traverse";
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
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    category: "CORRECTNESS",
    severity: "MEDIUM",
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

function propertyOf(object: t.ObjectExpression, name: string): t.ObjectProperty | null {
  for (const property of object.properties) {
    if (!t.isObjectProperty(property)) continue;
    if (t.isIdentifier(property.key, { name }) || t.isStringLiteral(property.key, { value: name }))
      return property;
  }
  return null;
}

function referencedNames(path: NodePath): Set<string> {
  const names = new Set<string>();
  if (path.isIdentifier() && path.isReferencedIdentifier()) names.add(path.node.name);
  path.traverse({ Identifier(inner) { if (inner.isReferencedIdentifier()) names.add(inner.node.name); } });
  return names;
}

export const QueryKeyCompletenessRule: VerificationRule = {
  id: "QUERY-001",
  name: "Incomplete Server-State Query Key",
  description: "Detects React Query functions that depend on request inputs missing from their cache key.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        const isUseQuery = t.isIdentifier(callee, { name: "useQuery" }) ||
          (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: "useQuery" }));
        const options = path.get("arguments.0");
        if (!isUseQuery || !options.isObjectExpression()) return;
        const keyProperty = propertyOf(options.node, "queryKey");
        const fnProperty = propertyOf(options.node, "queryFn");
        if (!keyProperty || !fnProperty) return;
        const keyPath = options.get("properties").find((property) => property.node === keyProperty);
        const fnPath = options.get("properties").find((property) => property.node === fnProperty);
        if (!keyPath?.isObjectProperty() || !fnPath?.isObjectProperty()) return;
        const keyValue = keyPath.get("value");
        const fnValue = fnPath.get("value");
        if (!fnValue.isFunction()) return;
        const keyed = referencedNames(keyValue);
        const missing = new Set<string>();
        fnValue.traverse({
          Identifier(identifier) {
            if (!identifier.isReferencedIdentifier() || keyed.has(identifier.node.name)) return;
            const name = identifier.node.name;
            if (/token|password|secret|credential|accessCode/i.test(name)) return;
            const binding = identifier.scope.getBinding(name);
            if (!binding || binding.path.isImportSpecifier() || binding.path.isImportDefaultSpecifier() ||
              binding.path.isImportNamespaceSpecifier() || binding.path.isFunctionDeclaration()) return;
            if (binding.scope === fnValue.scope) return;
            if (binding.path.isVariableDeclarator()) {
              const init = binding.path.node.init;
              if (t.isStringLiteral(init) || t.isNumericLiteral(init) || t.isBooleanLiteral(init)) return;
            }
            missing.add(name);
          },
        });
        if (missing.size === 0) return;
        const names = [...missing].sort().slice(0, 5);
        report(ctx, keyProperty, "QUERY-001", `Query key omits request input${names.length > 1 ? "s" : ""}: ${names.join(", ")}.`,
          "React Query reuses cache entries by queryKey. Different requests sharing a key can display data from another filter, tenant, account, or screen state.",
          "Add every response-shaping input to queryKey using stable, non-secret identifiers; alternatively remove the input from queryFn.");
      },
    });
  },
};

function isApiBoundary(filePath: string): boolean {
  return /(?:^|[\\/])(?:api|services?|clients?)(?:[\\/]|\.|$)/i.test(filePath) ||
    /(?:api|service|client|upload)[^\\/]*\.[cm]?[jt]sx?$/i.test(filePath);
}

export const RequestTimeoutRule: VerificationRule = {
  id: "SERVICE-003",
  name: "API Request Without Timeout",
  description: "Detects central API clients that can remain pending indefinitely.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    if (!isApiBoundary(ctx.filePath)) return;
    traverse(ctx.ast, {
      CallExpression(path) {
        if (t.isMemberExpression(path.node.callee) && t.isIdentifier(path.node.callee.object, { name: "axios" }) &&
          t.isIdentifier(path.node.callee.property, { name: "create" })) {
          const config = path.node.arguments[0];
          if (t.isObjectExpression(config) && !propertyOf(config, "timeout"))
            report(ctx, path.node, "SERVICE-003", "Central Axios client has no request timeout.",
              "A stalled connection can leave loading UI, submissions, and navigation pending indefinitely on poor mobile networks.",
              "Configure a bounded default timeout and allow explicit per-request overrides for long uploads.");
          return;
        }
        if (!t.isIdentifier(path.node.callee, { name: "fetch" })) return;
        const options = path.node.arguments[1];
        if (t.isObjectExpression(options) && propertyOf(options, "signal")) return;
        const scope = path.getFunctionParent();
        if (scope && /AbortSignal\.timeout|AbortController/.test(scope.toString())) return;
        report(ctx, path.node, "SERVICE-003", "API fetch has no timeout or abort signal.",
          "fetch has no built-in timeout, so a stalled request can keep the interface pending for an unbounded period.",
          "Pass an AbortSignal with a bounded timeout and compose it with caller cancellation.");
      },
    });
  },
};

function isDevGuard(node: t.Node): boolean {
  let found = false;
  const inspect = (current: unknown): void => {
    if (!current || typeof current !== "object" || found) return;
    if (t.isIdentifier(current as t.Node, { name: "DEV" })) found = true;
    for (const value of Object.values(current as Record<string, unknown>)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === "object") inspect(value);
    }
  };
  inspect(node);
  return found;
}

export const DevOnlyResponseValidationRule: VerificationRule = {
  id: "SERVICE-004",
  name: "Development-Only API Validation",
  description: "Detects runtime response-schema validation disabled in production builds.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      IfStatement(path) {
        if (!isDevGuard(path.node.test)) return;
        let validation: t.CallExpression | null = null;
        path.get("consequent").traverse({
          CallExpression(call) {
            const callee = call.node.callee;
            if (t.isMemberExpression(callee) && t.isIdentifier(callee.property) &&
              ["parse", "safeParse", "validate", "decode"].includes(callee.property.name)) validation = call.node;
          },
        });
        if (!validation) return;
        report(ctx, validation, "SERVICE-004", "API response validation only runs in development.",
          "Production is where malformed, partially deployed, or backward-incompatible payloads occur; disabling validation turns contract drift into downstream crashes or corrupt UI state.",
          "Validate untrusted response data in every build and return the parsed value, using lightweight schemas where performance matters.");
      },
    });
  },
};

export const UploadSizeValidationRule: VerificationRule = {
  id: "SERVICE-005",
  name: "Upload Without Size Bound",
  description: "Detects upload helpers that send a Blob/File without checking its size.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    if (!/upload/i.test(ctx.filePath)) return;
    traverse(ctx.ast, {
      Function(path) {
        const params = new Set<string>();
        for (const parameter of path.node.params) {
          if (t.isIdentifier(parameter) && /file|blob/i.test(parameter.name)) params.add(parameter.name);
          if (t.isObjectPattern(parameter)) for (const property of parameter.properties) {
            if (t.isObjectProperty(property) && t.isIdentifier(property.value) && /file|blob/i.test(property.value.name)) params.add(property.value.name);
          }
        }
        if (params.size === 0) return;
        let uploads = false;
        let checksSize = false;
        path.traverse({
          MemberExpression(member) {
            if (t.isIdentifier(member.node.object) && params.has(member.node.object.name) &&
              t.isIdentifier(member.node.property, { name: "size" })) checksSize = true;
          },
          CallExpression(call) {
            const callee = call.node.callee;
            const method = t.isMemberExpression(callee) && t.isIdentifier(callee.property) ? callee.property.name : null;
            if (method === "put" || t.isIdentifier(callee, { name: "fetch" })) {
              if (call.node.arguments.some((argument) => t.isIdentifier(argument) && params.has(argument.name))) uploads = true;
            }
          },
        });
        if (!uploads || checksSize) return;
        report(ctx, path.node, "SERVICE-005", "Upload helper sends a file without enforcing a size limit.",
          "Large user-selected files can exhaust memory, saturate mobile connections, exceed provider limits, and leave the UI stuck in a long-running request.",
          "Reject files above a documented byte limit before requesting or using the upload URL.");
      },
    });
  },
};

export const SERVER_STATE_RULES: VerificationRule[] = [
  QueryKeyCompletenessRule,
  RequestTimeoutRule,
  DevOnlyResponseValidationRule,
  UploadSizeValidationRule,
];
