import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { RuleContext, VerificationRule } from "../types/verifier";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";

function report(
  ctx: RuleContext,
  node: t.Node,
  ruleId: string,
  severity: "CRITICAL" | "HIGH" | "MEDIUM",
  message: string,
  explanation: string,
  summary: string,
  hint: string,
  cweId?: string,
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    cweId,
    category: ruleId.startsWith("REACT-") ? "CORRECTNESS" : "SECURITY",
    severity,
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary, llmPromptHint: hint },
  });
}

function jsxLiteral(attribute: t.JSXAttribute): string | boolean | null {
  if (attribute.value === null) return true;
  if (t.isStringLiteral(attribute.value)) return attribute.value.value;
  if (!t.isJSXExpressionContainer(attribute.value)) return null;
  const value = attribute.value.expression;
  if (t.isBooleanLiteral(value) || t.isStringLiteral(value)) return value.value;
  return null;
}

export const UnsafeWebViewSettingsRule: VerificationRule = {
  id: "RN-SEC-003",
  name: "Unsafe WebView Security Setting",
  description:
    "Detects explicitly enabled WebView file access and always-allow mixed content.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-749",
  check(ctx) {
    traverse(ctx.ast, {
      JSXOpeningElement(path) {
        if (!t.isJSXIdentifier(path.node.name, { name: "WebView" })) return;
        for (const attribute of path.node.attributes) {
          if (
            !t.isJSXAttribute(attribute) ||
            !t.isJSXIdentifier(attribute.name)
          )
            continue;
          const name = attribute.name.name;
          const value = jsxLiteral(attribute);
          const unsafeFileAccess =
            [
              "allowUniversalAccessFromFileURLs",
              "allowFileAccessFromFileURLs",
              "allowFileAccess",
            ].includes(name) && value === true;
          const unsafeMixedContent =
            name === "mixedContentMode" && value === "always";
          if (!unsafeFileAccess && !unsafeMixedContent) continue;
          report(
            ctx,
            attribute,
            "RN-SEC-003",
            name === "allowFileAccess" ? "MEDIUM" : "HIGH",
            `WebView enables unsafe '${name}' behavior.`,
            unsafeMixedContent
              ? "Always allowing mixed content lets an HTTPS page load resources over cleartext HTTP."
              : "WebView file-access capabilities can let malicious file-context content read local or private app data.",
            unsafeMixedContent
              ? 'Use mixedContentMode="never" or serve every resource over HTTPS.'
              : `Remove ${name} or set it to false; use WebViewAssetLoader for bundled content.`,
            `Disable the WebView '${name}' capability and use a narrowly scoped secure alternative.`,
            "CWE-749",
          );
        }
      },
    });
  },
};

export const WildcardPostMessageRule: VerificationRule = {
  id: "WEB-002",
  name: "Wildcard postMessage Target Origin",
  description:
    "Detects postMessage calls that disclose data to any target origin.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-346",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const call = path.node;
        if (
          !t.isMemberExpression(call.callee) ||
          !t.isIdentifier(call.callee.property, { name: "postMessage" })
        )
          return;
        const target = call.arguments[1];
        if (!t.isStringLiteral(target, { value: "*" })) return;
        report(
          ctx,
          call,
          "WEB-002",
          "HIGH",
          'postMessage sends to wildcard target origin "*".',
          "Any eligible window can receive the message, which may disclose its contents to an unintended origin.",
          "Specify the exact expected scheme, host, and port.",
          "Replace the wildcard targetOrigin with the exact trusted origin.",
          "CWE-346",
        );
      },
    });
  },
};

export const DisabledTlsVerificationRule: VerificationRule = {
  id: "NET-002",
  name: "TLS Certificate Verification Disabled",
  description:
    "Detects Node TLS clients explicitly configured to accept unauthorized certificates.",
  category: "SECURITY",
  defaultSeverity: "CRITICAL",
  cweId: "CWE-295",
  check(ctx) {
    traverse(ctx.ast, {
      ObjectProperty(path) {
        const key = path.node.key;
        const name = t.isIdentifier(key)
          ? key.name
          : t.isStringLiteral(key)
            ? key.value
            : null;
        if (
          name !== "rejectUnauthorized" ||
          !t.isBooleanLiteral(path.node.value, { value: false }) ||
          !isTlsClientOptions(path)
        )
          return;
        report(
          ctx,
          path.node,
          "NET-002",
          "CRITICAL",
          "TLS certificate verification is disabled.",
          "rejectUnauthorized: false accepts invalid or attacker-controlled certificates and enables machine-in-the-middle attacks.",
          "Remove the override and trust the correct CA certificate.",
          "Enable certificate verification; configure a trusted CA instead of accepting unauthorized certificates.",
          "CWE-295",
        );
      },
      AssignmentExpression(path) {
        const left = path.node.left;
        if (
          !t.isMemberExpression(left) ||
          !t.isStringLiteral(path.node.right, { value: "0" })
        )
          return;
        const chain = memberChain(left);
        if (chain !== "process.env.NODE_TLS_REJECT_UNAUTHORIZED") return;
        report(
          ctx,
          path.node,
          "NET-002",
          "CRITICAL",
          "NODE_TLS_REJECT_UNAUTHORIZED disables TLS verification.",
          "Setting NODE_TLS_REJECT_UNAUTHORIZED to 0 disables certificate validation process-wide.",
          "Remove this assignment and configure trusted development certificates.",
          "Delete the NODE_TLS_REJECT_UNAUTHORIZED override and install the appropriate CA.",
          "CWE-295",
        );
      },
    });
  },
};

function isTlsClientOptions(propertyPath: any): boolean {
  const objectPath = propertyPath.findParent((candidate: any) =>
    candidate.isObjectExpression(),
  );
  const parent = objectPath?.parentPath?.node;
  if (!parent) return false;
  if (t.isNewExpression(parent)) {
    return (
      t.isIdentifier(parent.callee, { name: "Agent" }) ||
      (t.isMemberExpression(parent.callee) &&
        t.isIdentifier(parent.callee.property, { name: "Agent" }))
    );
  }
  if (
    t.isCallExpression(parent) &&
    t.isMemberExpression(parent.callee) &&
    t.isIdentifier(parent.callee.property)
  ) {
    return ["connect", "request", "get"].includes(parent.callee.property.name);
  }
  return false;
}

function memberChain(member: t.MemberExpression): string | null {
  const parts: string[] = [];
  let current: t.Expression | t.Super = member;
  while (t.isMemberExpression(current)) {
    const property =
      !current.computed && t.isIdentifier(current.property)
        ? current.property.name
        : current.computed && t.isStringLiteral(current.property)
          ? current.property.value
          : null;
    if (!property) return null;
    parts.unshift(property);
    current = current.object;
  }
  if (!t.isIdentifier(current)) return null;
  parts.unshift(current.name);
  return parts.join(".");
}

export const EffectCleanupRule: VerificationRule = {
  id: "REACT-003",
  name: "Effect Resource Missing Cleanup",
  description:
    "Detects effects that create intervals or event listeners without returning cleanup.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (
          !t.isIdentifier(path.node.callee) ||
          !["useEffect", "useLayoutEffect"].includes(path.node.callee.name)
        )
          return;
        const setup = path.node.arguments[0];
        if (
          !t.isArrowFunctionExpression(setup) &&
          !t.isFunctionExpression(setup)
        )
          return;
        if (!t.isBlockStatement(setup.body)) return;
        let interval = false;
        let listener = false;
        let cleanup = false;
        path.get("arguments.0").traverse({
          Function(inner) {
            if (inner.node !== setup) inner.skip();
          },
          CallExpression(callPath) {
            const call = callPath.node;
            if (t.isIdentifier(call.callee, { name: "setInterval" }))
              interval = true;
            if (
              t.isMemberExpression(call.callee) &&
              t.isIdentifier(call.callee.property, {
                name: "addEventListener",
              }) &&
              !selfRemovingListener(call)
            )
              listener = true;
          },
          ReturnStatement(returnPath) {
            if (
              t.isArrowFunctionExpression(returnPath.node.argument) ||
              t.isFunctionExpression(returnPath.node.argument)
            )
              cleanup = true;
          },
        });
        if ((!interval && !listener) || cleanup) return;
        const resources = [
          interval ? "interval" : "",
          listener ? "event listener" : "",
        ]
          .filter(Boolean)
          .join(" and ");
        report(
          ctx,
          path.node,
          "REACT-003",
          "MEDIUM",
          `Effect creates ${resources} without returning cleanup.`,
          "React may rerun an effect and runs cleanup on unmount; unreleased resources can duplicate work, retain closures, and update unmounted components.",
          "Return a cleanup function that mirrors the setup.",
          "Return a function that clears the interval and/or removes the event listener created by this effect.",
        );
      },
    });
  },
};

function selfRemovingListener(call: t.CallExpression): boolean {
  const options = call.arguments[2];
  if (!t.isObjectExpression(options)) return false;
  return options.properties.some((property) => {
    if (!t.isObjectProperty(property)) return false;
    const name = t.isIdentifier(property.key)
      ? property.key.name
      : t.isStringLiteral(property.key)
        ? property.key.value
        : null;
    return (
      (name === "once" &&
        t.isBooleanLiteral(property.value, { value: true })) ||
      name === "signal"
    );
  });
}

export const FRAMEWORK_SECURITY_RULES: VerificationRule[] = [
  UnsafeWebViewSettingsRule,
  WildcardPostMessageRule,
  DisabledTlsVerificationRule,
  EffectCleanupRule,
];
