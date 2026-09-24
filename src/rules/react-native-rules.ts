import traverse from "@babel/traverse";
import * as t from "@babel/types";
import {
  VerificationRule,
  RuleContext,
  CFG,
  MemoryAbstractState,
} from "../types/verifier";
import { nodeToLocation, extractCodeSnippet } from "../parser/ast";
import { NullabilityDomain } from "../abstract-interpreter/domain";
import { refineState } from "../abstract-interpreter/refine";
import { HYGIENE_RULES } from "./hygiene-rules";
import { FRAMEWORK_SECURITY_RULES } from "./framework-security-rules";
import { CWE_SECURITY_RULES } from "./cwe-security-rules";
import { APPLICATION_SECURITY_RULES } from "./application-security-rules";
import { CORRECTNESS_RULES } from "./correctness-rules";
import { REACT_CORRECTNESS_RULES } from "./react-correctness-rules";
import { REACT19_RULES } from "./react19-rules";
import { RELIABILITY_RULES } from "./reliability-rules";
import { SEMANTIC_RULES } from "./semantic-rules";
import { MOBILE_CONFIG_RULES } from "./mobile-config-rules";
import { BACKEND_RULES } from "./backend-rules";
import { DEPLOYMENT_RULES } from "./deployment-rules";
import { EXPOROUTER_RULES } from "./expo-router-rules";
import { NATIVE_CONSISTENCY_RULES } from "./native-consistency-rules";

// =========================================================================
// 1. Insecure AsyncStorage for Sensitive Data (CWE-312)
// =========================================================================
export const InsecureAsyncStorageRule: VerificationRule = {
  id: "RN-SEC-001",
  name: "Insecure AsyncStorage Usage for Sensitive Data",
  description:
    "AsyncStorage is unencrypted on iOS/Android. Sensitive tokens or credentials should use Expo SecureStore.",
  category: "REACT_NATIVE_EXPO",
  defaultSeverity: "HIGH",
  cweId: "CWE-312",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (
          t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object, { name: "AsyncStorage" }) &&
          t.isIdentifier(callee.property, { name: "setItem" })
        ) {
          const [keyArg] = path.node.arguments;
          const keyStr = t.isStringLiteral(keyArg)
            ? keyArg.value
            : t.isTemplateLiteral(keyArg)
              ? (keyArg.quasis[0]?.value.cooked ?? "")
              : null;

          if (keyStr !== null) {
            const key = keyStr.toLowerCase();
            const sensitiveKeywords = [
              "token",
              "auth",
              "jwt",
              "secret",
              "password",
              "session",
              "credential",
              "apikey",
              "api_key",
            ];
            const isSensitive = sensitiveKeywords.some((kw) =>
              key.includes(kw),
            );

            if (isSensitive) {
              const loc = nodeToLocation(path.node);
              ctx.report({
                id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:RN-SEC-001`,
                ruleId: "RN-SEC-001",
                cweId: "CWE-312",
                category: "REACT_NATIVE_EXPO",
                severity: "HIGH",
                message: `Sensitive key "${keyStr}" stored in unencrypted AsyncStorage.`,
                explanation:
                  "AsyncStorage is stored in plain text (SQLite/SharedPreferences) and is vulnerable to extraction on rooted/jailbroken devices or backup exports.",
                loc,
                codeSnippet: extractCodeSnippet(ctx.lines, loc),
                remediation: {
                  summary:
                    "Use Expo SecureStore instead of AsyncStorage for sensitive credentials.",
                  suggestedFix: "await SecureStore.setItemAsync(key, value);",
                  llmPromptHint:
                    "Replace AsyncStorage.setItem with SecureStore.setItemAsync from expo-secure-store.",
                },
              });
            }
          }
        }
      },
    });
  },
};

// =========================================================================
// 2. WebView Unsanitized HTML / Script Injection (CWE-79 / XSS)
// =========================================================================
export const WebViewInjectionRule: VerificationRule = {
  id: "RN-SEC-002",
  name: "WebView Dynamic Content Injection",
  description:
    "Passing dynamic un-sanitized HTML or scripts to react-native-webview can cause XSS or bridge compromise.",
  category: "SECURITY",
  defaultSeverity: "CRITICAL",
  cweId: "CWE-79",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      JSXElement(path) {
        const opening = path.node.openingElement;
        if (!t.isJSXIdentifier(opening.name, { name: "WebView" })) return;

        for (const attr of opening.attributes) {
          if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name))
            continue;
          const attrName = attr.name.name;

          // source={{ html: <dynamic> }} — dynamic HTML injection
          if (
            attrName === "source" &&
            t.isJSXExpressionContainer(attr.value) &&
            t.isObjectExpression(attr.value.expression)
          ) {
            for (const prop of attr.value.expression.properties) {
              if (
                t.isObjectProperty(prop) &&
                t.isIdentifier(prop.key, { name: "html" }) &&
                !t.isStringLiteral(prop.value)
              ) {
                reportWebViewInjection(ctx, nodeToLocation(prop), "html");
              }
            }
          }

          // injectedJavaScript={ <dynamic> } — script injection vector
          if (
            attrName === "injectedJavaScript" &&
            t.isJSXExpressionContainer(attr.value) &&
            !t.isStringLiteral(attr.value.expression)
          ) {
            reportWebViewInjection(
              ctx,
              nodeToLocation(attr),
              "injectedJavaScript",
            );
          }
        }
      },
    });
  },
};

function reportWebViewInjection(
  ctx: RuleContext,
  loc: ReturnType<typeof nodeToLocation>,
  prop: "html" | "injectedJavaScript",
): void {
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:RN-SEC-002`,
    ruleId: "RN-SEC-002",
    cweId: "CWE-79",
    category: "SECURITY",
    severity: "CRITICAL",
    message: `Dynamic un-sanitized content passed to WebView ${prop}.`,
    explanation:
      "Injecting dynamic HTML or scripts into a WebView lets malicious code execute within the app origin or reach exposed postMessage native bridge handlers.",
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: {
      summary:
        "Sanitize input with DOMPurify, or render with native React Native components instead of inline HTML.",
      llmPromptHint: `Ensure WebView ${prop} content is strictly sanitized or rendered using native React Native components.`,
    },
  });
}

// =========================================================================
// 3. React Infinite Re-render Loop Detection (CWE-835)
// =========================================================================
export const InfiniteRenderLoopRule: VerificationRule = {
  id: "REACT-001",
  name: "Unconditional State Update in Render or Effect",
  description:
    "Calling setState unconditionally inside the render body or inside useEffect without dependencies causes infinite re-render loops.",
  category: "REACT_HOOKS",
  defaultSeverity: "CRITICAL",
  cweId: "CWE-835",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (!t.isIdentifier(callee, { name: "useEffect" })) return;

        const [_cb, deps] = path.node.arguments;
        if (deps) return; // dependency array present: dep-scoped, fine

        path.traverse({
          CallExpression(innerPath) {
            if (!t.isIdentifier(innerPath.node.callee)) return;
            const name = innerPath.node.callee.name;
            // `setX` shape only — but timer globals also match, so exclude them
            const TIMER_GLOBALS = new Set([
              "setTimeout",
              "setInterval",
              "setImmediate",
            ]);
            if (TIMER_GLOBALS.has(name) || !/^set[A-Z]/.test(name)) return;

            const loc = nodeToLocation(innerPath.node);
            ctx.report({
              id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:REACT-001`,
              ruleId: "REACT-001",
              cweId: "CWE-835",
              category: "REACT_HOOKS",
              severity: "CRITICAL",
              message: `State setter '${name}' called inside useEffect without a dependency array.`,
              explanation:
                "This triggers an unconditional state update after every render, causing an infinite re-render loop that freezes the UI.",
              loc,
              codeSnippet: extractCodeSnippet(ctx.lines, loc),
              remediation: {
                summary:
                  "Add a dependency array to useEffect or remove the state update.",
                suggestedFix: "useEffect(() => { ... }, []);",
                llmPromptHint:
                  "Add a dependency array [deps] to the useEffect hook or move the state setter outside.",
              },
            });
          },
        });
      },
    });
  },
};

// =========================================================================
// 4. Conditional React Hook Invocations (React Rules of Hooks)
// =========================================================================
export const ConditionalHookRule: VerificationRule = {
  id: "REACT-002",
  name: "Conditional Hook Invocation",
  description:
    "React Hooks must be called unconditionally at the top level of the component.",
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (!t.isIdentifier(callee) || !/^use[A-Z]/.test(callee.name)) return;

        // Walk from the hook call up to its enclosing function. For expression
        // conditions, only the branch/right operand is conditional: the test
        // and left operand always execute.
        const fnParent = path.getFunctionParent();
        let cur: any = path.parentPath;
        let child: any = path;
        let violated = false;
        while (cur && cur.node !== (fnParent ? fnParent.node : null)) {
          const inConditionalBranch =
            (cur.isIfStatement() && child.node !== cur.node.test) ||
            cur.isWhileStatement() ||
            cur.isForStatement() ||
            cur.isForOfStatement() ||
            cur.isForInStatement() ||
            cur.isDoWhileStatement() ||
            cur.isSwitchStatement() ||
            (cur.isConditionalExpression() && child.node !== cur.node.test) ||
            (cur.isLogicalExpression() && child.node === cur.node.right) ||
            cur.isTryStatement() ||
            cur.isCatchClause();
          if (inConditionalBranch) {
            violated = true;
            break;
          }
          child = cur;
          cur = cur.parentPath;
        }

        if (violated) {
          const loc = nodeToLocation(path.node);
          ctx.report({
            id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:REACT-002`,
            ruleId: "REACT-002",
            category: "REACT_HOOKS",
            severity: "HIGH",
            message: `React Hook '${callee.name}' called inside a conditional or loop statement.`,
            explanation:
              "React relies on the order in which Hooks are called. Calling hooks conditionally breaks state preservation across renders.",
            loc,
            codeSnippet: extractCodeSnippet(ctx.lines, loc),
            remediation: {
              summary:
                "Move the hook call to the top level of the React component.",
              llmPromptHint: `Refactor so '${callee.name}' is always called at the top level of the component; move conditionals inside the hook or effect.`,
            },
          });
        }
      },
    });
  },
};

// =========================================================================
// 5. Hardcoded Secret / API Key Exposure (CWE-798)
// =========================================================================

const SECRET_NAME_KEYWORDS = [
  "apikey",
  "api_key",
  "secretkey",
  "secret_key",
  "privatekey",
  "private_key",
  "authtoken",
  "auth_token",
  "jwt_secret",
  "accesskey",
  "access_key",
  "clientsecret",
  "client_secret",
];
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk_live_[0-9a-zA-Z]{16,}/, // Stripe live
  /^sk_test_[0-9a-zA-Z]{16,}/, // Stripe test
  /^ghp_[0-9a-zA-Z]{30,}/, // GitHub PAT
  /^github_pat_[0-9a-zA-Z_]{20,}/, // GitHub fine-grained PAT
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^xox[bpas]-[0-9a-zA-Z-]{10,}/, // Slack token
  /^AIzaSy[0-9A-Za-z_-]{33}/, // Google API key
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, // PEM private key
  /^eyJ[a-zA-Z0-9_-]+\.eyJ?[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/, // JWT
];

function isSecretLike(name: string, value: string): boolean {
  const n = name.toLowerCase();
  const nameHit = SECRET_NAME_KEYWORDS.some((kw) => n.includes(kw));
  const patternHit = SECRET_VALUE_PATTERNS.some((re) => re.test(value));
  if (patternHit) return true;
  if (!nameHit || value.length < 12) return false;

  // Storage/config identifiers often have sensitive names but are not secret
  // values: `AUTH_TOKEN_KEY = 'app_auth_access_token'`. For name-only matches,
  // require credential-like character complexity to keep CRITICAL findings
  // high confidence.
  const characterClasses = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /[0-9]/.test(value),
    /[^a-zA-Z0-9]/.test(value),
  ].filter(Boolean).length;
  return characterClasses >= 3;
}

function reportSecret(ctx: RuleContext, name: string, loc: any): void {
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:SEC-003`,
    ruleId: "SEC-003",
    cweId: "CWE-798",
    category: "SECURITY",
    severity: "CRITICAL",
    message: `Hardcoded secret detected in '${name}'.`,
    explanation:
      "Secrets hardcoded in frontend or React Native apps are bundled into client code and recoverable via apk/ipa extraction or bundle inspection.",
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: {
      summary:
        "Move the secret to a backend server or a build-time-injected vault; never ship it in the client bundle.",
      llmPromptHint: `Remove hardcoded credential '${name}'. Use secure backend authentication or a server proxy; client-side env vars are still extractable.`,
    },
  });
}

export const HardcodedSecretsRule: VerificationRule = {
  id: "SEC-003",
  name: "Hardcoded Secret or API Key in Client Bundle",
  description:
    "Hardcoded API secrets, private keys, or tokens in mobile/frontend code are easily extracted by decompilation.",
  category: "SECURITY",
  defaultSeverity: "CRITICAL",
  cweId: "CWE-798",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      // const apiKey = "sk_live_..."
      VariableDeclarator(path) {
        if (!t.isIdentifier(path.node.id) || !t.isStringLiteral(path.node.init))
          return;
        if (isSecretLike(path.node.id.name, path.node.init.value)) {
          reportSecret(ctx, path.node.id.name, nodeToLocation(path.node));
        }
      },
      // config.apiKey = "sk_live_..."
      AssignmentExpression(path) {
        const { left, right } = path.node;
        if (!t.isStringLiteral(right)) return;
        let name: string | null = null;
        if (t.isIdentifier(left)) name = left.name;
        if (t.isMemberExpression(left) && t.isIdentifier(left.property))
          name = left.property.name;
        if (name && isSecretLike(name, right.value)) {
          reportSecret(ctx, name, nodeToLocation(path.node));
        }
      },
      // { apiKey: "sk_live_..." } object literals
      ObjectProperty(path) {
        if (!t.isStringLiteral(path.node.value)) return;
        const key = path.node.key;
        const name = t.isIdentifier(key)
          ? key.name
          : t.isStringLiteral(key)
            ? key.value
            : null;
        if (name && isSecretLike(name, path.node.value.value)) {
          reportSecret(ctx, name, nodeToLocation(path.node));
        }
      },
    });
  },
};

// =========================================================================

// =========================================================================
// 6. Null Dereference via Abstract Interpretation (CWE-476)
// =========================================================================
export const NullDereferenceRule: VerificationRule = {
  id: "AI-NULL-001",
  name: "Potential Null / Undefined Dereference",
  description:
    "Accessing properties on values abstract interpretation proves can be null or undefined on some path.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  cweId: "CWE-476",
  check: (ctx: RuleContext) => {
    for (const cfg of ctx.cfgs) {
      if (!cfg.statementStates) continue;

      for (const [, node] of cfg.nodes) {
        for (const stmt of node.statements) {
          const stmtState = cfg.statementStates.get(stmt) || node.stateIn;
          walkStatement(stmt, stmtState, ctx);
        }
      }
    }
  },
};

function walkStatement(
  stmt: any,
  stmtState: MemoryAbstractState,
  ctx: RuleContext,
): void {
  const checkMember = (expr: any, state: MemoryAbstractState) => {
    if (t.isMemberExpression(expr) && !expr.optional) {
      const objectKey = t.isIdentifier(expr.object)
        ? ctx.symbols.key(expr.object)
        : t.isMemberExpression(expr.object) ||
            t.isOptionalMemberExpression(expr.object)
          ? ctx.symbols.keyForMember(expr.object)
          : null;
      const varName = memberDisplayName(expr.object);
      const st = objectKey ? state.get(objectKey) : undefined;

      // Only flag when the lattice KNOWS the value can be nullish.
      // Flagging unknown ('Top') values drowns users in false positives.
      if (st && NullabilityDomain.isKnownPossiblyNull(st.nullability)) {
        const loc = nodeToLocation(expr);
        const definite =
          st.nullability === "Null" || st.nullability === "Undefined";
        reportNullDeref(
          ctx,
          varName,
          (expr.property as t.Identifier).name,
          st.nullability,
          definite,
          loc,
        );
      }
    }
  };

  const traverseNode = (curr: any, state: MemoryAbstractState) => {
    if (!curr || typeof curr !== "object") return;
    // Never descend into nested function bodies: they are analyzed as their
    // own CFG roots. Checking them against the OUTER state would ignore the
    // guards they contain (e.g. `const f = () => { if (!x) return; x.y; }`
    // flagged x.y with the outer, unguarded fact for x).
    if (curr !== stmt && isFunctionNode(curr)) return;

    // JavaScript evaluates the RHS of these expressions under a guard. Carry
    // that path fact into JSX and other nested expressions such as
    // `user && <Name>{user.name}</Name>`.
    if (t.isLogicalExpression(curr)) {
      traverseNode(curr.left, state);
      const rightState =
        curr.operator === "&&"
          ? refineState(state, curr.left, true, ctx.symbols)
          : curr.operator === "||"
            ? refineState(state, curr.left, false, ctx.symbols)
            : state;
      traverseNode(curr.right, rightState);
      return;
    }
    if (t.isConditionalExpression(curr)) {
      traverseNode(curr.test, state);
      traverseNode(
        curr.consequent,
        refineState(state, curr.test, true, ctx.symbols),
      );
      traverseNode(
        curr.alternate,
        refineState(state, curr.test, false, ctx.symbols),
      );
      return;
    }

    if (t.isMemberExpression(curr)) checkMember(curr, state);
    for (const key of Object.keys(curr)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const child = curr[key];
      if (Array.isArray(child)) {
        for (const item of child) traverseNode(item, state);
      } else if (child && typeof child === "object" && child.type) {
        traverseNode(child, state);
      }
    }
  };

  traverseNode(stmt, stmtState);
}

function memberDisplayName(expr: t.Expression | t.Super): string {
  if (t.isIdentifier(expr)) return expr.name;
  if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
    const base = memberDisplayName(expr.object);
    const property =
      !expr.computed && t.isIdentifier(expr.property)
        ? expr.property.name
        : t.isStringLiteral(expr.property) || t.isNumericLiteral(expr.property)
          ? String(expr.property.value)
          : "[computed]";
    return `${base}.${property}`;
  }
  return "<expression>";
}

function isFunctionNode(n: any): boolean {
  return (
    t.isFunctionDeclaration(n) ||
    t.isFunctionExpression(n) ||
    t.isArrowFunctionExpression(n) ||
    t.isObjectMethod(n) ||
    t.isClassMethod(n)
  );
}

function reportNullDeref(
  ctx: RuleContext,
  varName: string,
  propName: string,
  nullability: string,
  definite: boolean,
  loc: any,
): void {
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:AI-NULL-001`,
    ruleId: "AI-NULL-001",
    cweId: "CWE-476",
    category: "CORRECTNESS",
    severity: definite ? "HIGH" : "MEDIUM",
    message: `Possible ${definite ? "" : "path-dependent "}null/undefined dereference on '${varName}.${propName}'.`,
    explanation: `Abstract interpretation determined that '${varName}' has nullability state '${nullability}' at this program point.`,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    abstractInvariants: {
      [varName]: `Nullability: ${nullability}`,
    },
    remediation: {
      summary: `Use optional chaining '${varName}?.${propName}' or add a null guard.`,
      suggestedFix: `${varName}?.${propName}`,
      llmPromptHint: `Use optional chaining '?.' or verify '${varName}' is defined before accessing the property.`,
    },
  });
}
import { TaintDomain, MemoryState } from "../abstract-interpreter/domain";

// =========================================================================
// 7. Taint Flow: Untrusted Value Reaches a Dangerous Sink (CWE-312 / CWE-79)
// =========================================================================
export const TaintFlowRule: VerificationRule = {
  id: "AI-TAINT-001",
  name: "Tainted Value Flows into Dangerous Sink",
  description:
    "An untrusted value (deep link, navigation params, unencrypted storage) flows into a dangerous sink.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  check: (ctx: RuleContext) => {
    for (const cfg of ctx.cfgs) {
      if (!cfg.statementStates) continue;

      for (const [, node] of cfg.nodes) {
        for (const stmt of node.statements) {
          const stmtState = cfg.statementStates.get(stmt) || node.stateIn;

          // Sink A: AsyncStorage.setItem(key, <tainted>)
          const setItemSink = findSetItemSink(stmt, stmtState, ctx);
          if (setItemSink) {
            ctx.report({
              id: `${ctx.filePath}:${loc(setItemSink).start.line}:AI-TAINT-001`,
              ruleId: "AI-TAINT-001",
              cweId: "CWE-312",
              category: "SECURITY",
              severity: "HIGH",
              message: `Tainted value from '${setItemSink.sources.join(", ")}' flows into unencrypted AsyncStorage.`,
              explanation:
                "Deep-link or navigation params persisted unencrypted can be manipulated on-device; store untrusted data only after validation.",
              loc: loc(setItemSink),
              codeSnippet: extractCodeSnippet(ctx.lines, loc(setItemSink)),
              abstractInvariants: {
                value: `Taint sources: ${setItemSink.sources.join(", ")}`,
              },
              remediation: {
                summary:
                  "Validate/sanitize the value, or use SecureStore if the data is sensitive.",
                llmPromptHint:
                  "Validate the untrusted value before persisting it, or switch to SecureStore for sensitive data.",
              },
            });
          }

          // Sink B: WebView html={tainted} / injectedJavaScript={tainted}
          const webviewSink = findWebViewSink(stmt, stmtState, ctx);
          if (webviewSink) {
            ctx.report({
              id: `${ctx.filePath}:${loc(webviewSink).start.line}:AI-TAINT-001`,
              ruleId: "AI-TAINT-001",
              cweId: "CWE-79",
              category: "SECURITY",
              severity: "HIGH",
              message: `Tainted value from '${webviewSink.sources.join(", ")}' reaches WebView ${webviewSink.prop}.`,
              explanation:
                "Untrusted content rendered as WebView HTML/script executes with the page origin and can hit native bridge handlers (XSS).",
              loc: loc(webviewSink),
              codeSnippet: extractCodeSnippet(ctx.lines, loc(webviewSink)),
              abstractInvariants: {
                value: `Taint sources: ${webviewSink.sources.join(", ")}`,
              },
              remediation: {
                summary: "Sanitize with DOMPurify or render natively.",
                llmPromptHint:
                  "Sanitize untrusted WebView content or render it with native components.",
              },
            });
          }

          const summarizedSink = findSummarizedSink(stmt, stmtState, ctx);
          if (summarizedSink) {
            const destination =
              summarizedSink.prop === "summarized WebView sink"
                ? "a WebView sink through a helper function"
                : "unencrypted AsyncStorage through a helper function";
            ctx.report({
              id: `${ctx.filePath}:${loc(summarizedSink).start.line}:AI-TAINT-001-summary`,
              ruleId: "AI-TAINT-001",
              cweId:
                summarizedSink.prop === "summarized WebView sink"
                  ? "CWE-79"
                  : "CWE-312",
              category: "SECURITY",
              severity: "HIGH",
              message: `Tainted value from '${summarizedSink.sources.join(", ")}' reaches ${destination}.`,
              explanation:
                "A bounded function summary proves that this argument flows to a dangerous sink in the called helper.",
              loc: loc(summarizedSink),
              codeSnippet: extractCodeSnippet(ctx.lines, loc(summarizedSink)),
              abstractInvariants: {
                value: `Taint sources: ${summarizedSink.sources.join(", ")}`,
              },
              remediation: {
                summary:
                  "Validate or sanitize the argument before calling the helper.",
                llmPromptHint:
                  "Validate or sanitize the tainted argument before passing it to this sink-bearing helper.",
              },
            });
          }

          const callbackSink = findCollectionCallbackSink(stmt, stmtState, ctx);
          if (callbackSink) {
            ctx.report({
              id: `${ctx.filePath}:${loc(callbackSink).start.line}:AI-TAINT-001-callback`,
              ruleId: "AI-TAINT-001",
              cweId: callbackSink.prop === "WebView" ? "CWE-79" : "CWE-312",
              category: "SECURITY",
              severity: "HIGH",
              message: `Tainted collection element from '${callbackSink.sources.join(", ")}' reaches ${callbackSink.prop} inside a callback.`,
              explanation:
                "The receiver is tainted and this standard collection callback passes each element into a dangerous sink.",
              loc: loc(callbackSink),
              codeSnippet: extractCodeSnippet(ctx.lines, loc(callbackSink)),
              abstractInvariants: {
                value: `Taint sources: ${callbackSink.sources.join(", ")}`,
              },
              remediation: {
                summary:
                  "Validate or sanitize each element before it reaches the sink.",
                llmPromptHint:
                  "Validate or sanitize the callback element before passing it to this sink.",
              },
            });
          }
        }
      }
    }
  },
};

interface SinkHit {
  loc: any;
  sources: string[];
  prop: string;
}

function loc(hit: SinkHit): any {
  return hit.loc;
}

function taintOf(
  expr: any,
  stmtState: MemoryAbstractState,
  ctx: RuleContext,
  depth = 0,
): string[] | null {
  if (!expr || depth > 8) return null;
  const key = t.isIdentifier(expr)
    ? ctx.symbols.key(expr)
    : t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)
      ? ctx.symbols.keyForMember(expr)
      : null;
  if (key) {
    const st = stmtState.get(key);
    return st && st.taint.isTainted ? st.taint.sources : null;
  }
  if (t.isCallExpression(expr)) {
    const name = summarizedCalleeName(expr.callee);
    const value = name ? ctx.functionSummaries.get(name)?.value : undefined;
    if (value?.kind === "PARAMETER" && !value.sanitized) {
      const argument = expr.arguments[value.parameterIndex];
      if (argument && t.isIdentifier(argument) && value.fieldPath?.length) {
        const state = stmtState.get(
          [ctx.symbols.key(argument), ...value.fieldPath].join("."),
        );
        return state?.taint.isTainted ? state.taint.sources : null;
      }
      return argument && t.isExpression(argument)
        ? taintOf(argument, stmtState, ctx, depth + 1)
        : null;
    }
  }
  if (
    t.isTSAsExpression(expr) ||
    t.isTSSatisfiesExpression(expr) ||
    t.isTSTypeAssertion(expr) ||
    t.isTSNonNullExpression(expr) ||
    t.isParenthesizedExpression(expr)
  ) {
    return taintOf(expr.expression, stmtState, ctx, depth + 1);
  }
  return null;
}

function findSummarizedSink(
  stmt: any,
  stmtState: MemoryAbstractState,
  ctx: RuleContext,
): SinkHit | null {
  let hit: SinkHit | null = null;
  const walk = (curr: any) => {
    if (!curr || typeof curr !== "object" || hit) return;
    if (t.isCallExpression(curr)) {
      const name = summarizedCalleeName(curr.callee);
      const summary = name ? ctx.functionSummaries.get(name) : undefined;
      for (const sink of summary?.taintSinks ?? []) {
        const argument = curr.arguments[sink.parameterIndex];
        const sources =
          argument && t.isExpression(argument)
            ? taintOf(argument, stmtState, ctx)
            : null;
        if (sources) {
          hit = {
            loc: nodeToLocation(curr),
            sources,
            prop:
              sink.kind === "WEBVIEW"
                ? "summarized WebView sink"
                : "summarized storage sink",
          };
          return;
        }
      }
    }
    for (const key of Object.keys(curr)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const child = curr[key];
      if (Array.isArray(child)) for (const item of child) walk(item);
      else if (child && typeof child === "object" && child.type) walk(child);
    }
  };
  walk(stmt);
  return hit;
}

function summarizedCalleeName(
  callee: t.Expression | t.V8IntrinsicIdentifier,
): string | null {
  if (t.isIdentifier(callee)) return callee.name;
  if (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.object) &&
    t.isIdentifier(callee.property)
  ) {
    return `${callee.object.name}.${callee.property.name}`;
  }
  return null;
}

const ELEMENT_CALLBACKS = new Set([
  "forEach",
  "map",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "flatMap",
]);

function findCollectionCallbackSink(
  stmt: any,
  stmtState: MemoryAbstractState,
  ctx: RuleContext,
): SinkHit | null {
  let hit: SinkHit | null = null;
  const walk = (curr: any) => {
    if (!curr || typeof curr !== "object" || hit) return;
    if (
      t.isCallExpression(curr) &&
      t.isMemberExpression(curr.callee) &&
      !curr.callee.computed &&
      t.isIdentifier(curr.callee.property) &&
      ELEMENT_CALLBACKS.has(curr.callee.property.name) &&
      t.isExpression(curr.callee.object)
    ) {
      const sources = taintOf(curr.callee.object, stmtState, ctx);
      const callback = curr.arguments[0];
      if (
        sources &&
        (t.isArrowFunctionExpression(callback) ||
          t.isFunctionExpression(callback))
      ) {
        const parameter = callback.params[0];
        if (t.isIdentifier(parameter)) {
          const sink = callbackParameterSink(
            callback.body,
            parameter.name,
            ctx,
          );
          if (sink) {
            hit = { loc: nodeToLocation(sink.node), sources, prop: sink.kind };
            return;
          }
        }
      }
    }
    for (const key of Object.keys(curr)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const child = curr[key];
      if (Array.isArray(child)) for (const item of child) walk(item);
      else if (child && typeof child === "object" && child.type) walk(child);
    }
  };
  walk(stmt);
  return hit;
}

function callbackParameterSink(
  body: t.BlockStatement | t.Expression,
  parameterName: string,
  ctx: RuleContext,
): { node: t.Node; kind: string } | null {
  let found: { node: t.Node; kind: string } | null = null;
  const walk = (curr: any) => {
    if (!curr || typeof curr !== "object" || found) return;
    if (curr !== body && isFunctionNode(curr)) return;
    if (t.isCallExpression(curr)) {
      if (
        t.isMemberExpression(curr.callee) &&
        t.isIdentifier(curr.callee.object, { name: "AsyncStorage" }) &&
        t.isIdentifier(curr.callee.property, { name: "setItem" }) &&
        t.isIdentifier(curr.arguments[1], { name: parameterName })
      ) {
        found = { node: curr, kind: "AsyncStorage" };
        return;
      }
      const name = summarizedCalleeName(curr.callee);
      const summary = name ? ctx.functionSummaries.get(name) : undefined;
      if (
        (summary?.taintSinks ?? []).some((sink) =>
          t.isIdentifier(curr.arguments[sink.parameterIndex], {
            name: parameterName,
          }),
        )
      ) {
        found = { node: curr, kind: "a sink-bearing helper" };
        return;
      }
    }
    for (const key of Object.keys(curr)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const child = curr[key];
      if (Array.isArray(child)) for (const item of child) walk(item);
      else if (child && typeof child === "object" && child.type) walk(child);
    }
  };
  walk(body);
  return found;
}

function findSetItemSink(
  stmt: any,
  stmtState: MemoryAbstractState,
  ctx: RuleContext,
): SinkHit | null {
  let hit: SinkHit | null = null;

  const walk = (curr: any) => {
    if (!curr || typeof curr !== "object" || hit) return;
    if (t.isCallExpression(curr) && t.isMemberExpression(curr.callee)) {
      const c = curr.callee;
      if (
        t.isIdentifier(c.object, { name: "AsyncStorage" }) &&
        t.isIdentifier(c.property, { name: "setItem" })
      ) {
        const valueArg = curr.arguments[1];
        const sources = taintOf(valueArg, stmtState, ctx);
        if (sources) {
          hit = { loc: nodeToLocation(curr), sources, prop: "setItem value" };
          return;
        }
      }
    }
    for (const key of Object.keys(curr)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const child = curr[key];
      if (Array.isArray(child)) {
        for (const item of child) walk(item);
      } else if (child && typeof child === "object" && child.type) {
        walk(child);
      }
    }
  };

  walk(stmt);
  return hit;
}

function findWebViewSink(
  stmt: any,
  stmtState: MemoryAbstractState,
  ctx: RuleContext,
): SinkHit | null {
  let hit: SinkHit | null = null;

  const walk = (curr: any) => {
    if (!curr || typeof curr !== "object" || hit) return;
    if (
      t.isJSXElement(curr) &&
      t.isJSXIdentifier(curr.openingElement.name, { name: "WebView" })
    ) {
      for (const attr of curr.openingElement.attributes) {
        if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue;
        if (
          attr.name.name !== "html" &&
          attr.name.name !== "injectedJavaScript" &&
          attr.name.name !== "source"
        )
          continue;

        let expr: any = null;
        if (
          t.isJSXExpressionContainer(attr.value) &&
          t.isIdentifier(attr.value.expression)
        ) {
          expr = attr.value.expression;
        } else if (
          t.isJSXExpressionContainer(attr.value) &&
          t.isObjectExpression(attr.value.expression)
        ) {
          const htmlProp = attr.value.expression.properties.find(
            (p: any) =>
              t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "html" }),
          );
          const htmlVal = (htmlProp as any)?.value;
          if (htmlProp && t.isIdentifier(htmlVal)) expr = htmlVal;
        }
        const sources = expr ? taintOf(expr, stmtState, ctx) : null;
        if (sources) {
          hit = { loc: nodeToLocation(attr), sources, prop: attr.name.name };
          return;
        }
      }
    }
    for (const key of Object.keys(curr)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const child = curr[key];
      if (Array.isArray(child)) {
        for (const item of child) walk(item);
      } else if (child && typeof child === "object" && child.type) {
        walk(child);
      }
    }
  };

  walk(stmt);
  return hit;
}

// =========================================================================
// 8. eval / new Function (CWE-95)
// =========================================================================
export const EvalRule: VerificationRule = {
  id: "SEC-004",
  name: "Dynamic Code Evaluation",
  description:
    "eval() and new Function() execute arbitrary strings as code — a code-injection vector and CSP blocker.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-95",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      CallExpression(path) {
        const c = path.node.callee;
        const isEval = t.isIdentifier(c, { name: "eval" });
        if (!isEval) return;

        const loc = nodeToLocation(path.node);
        ctx.report({
          id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:SEC-004`,
          ruleId: "SEC-004",
          cweId: "CWE-95",
          category: "SECURITY",
          severity: "HIGH",
          message: isEval ? "eval() used." : "new Function(...) used.",
          explanation:
            "Dynamic code evaluation executes arbitrary strings; injected input becomes executable code, and it is blocked by default CSP.",
          loc,
          codeSnippet: extractCodeSnippet(ctx.lines, loc),
          remediation: {
            summary:
              "Replace dynamic evaluation with explicit logic, JSON.parse, or a lookup map.",
            llmPromptHint:
              "Remove eval()/new Function() and replace with explicit branching or JSON.parse.",
          },
        });
      },
      NewExpression(path) {
        if (!t.isIdentifier(path.node.callee, { name: "Function" })) return;
        const loc = nodeToLocation(path.node);
        ctx.report({
          id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:SEC-004`,
          ruleId: "SEC-004",
          cweId: "CWE-95",
          category: "SECURITY",
          severity: "HIGH",
          message: "new Function(...) used.",
          explanation:
            "new Function() compiles arbitrary strings into executable code, same risk profile as eval().",
          loc,
          codeSnippet: extractCodeSnippet(ctx.lines, loc),
          remediation: {
            summary:
              "Replace dynamic evaluation with explicit logic or JSON.parse.",
            llmPromptHint:
              "Remove new Function() and replace with explicit branching or JSON.parse.",
          },
        });
      },
    });
  },
};

// =========================================================================
// 9. dangerouslySetInnerHTML (CWE-79)
// =========================================================================
export const DangerousInnerHTMLRule: VerificationRule = {
  id: "SEC-005",
  name: "Dynamic dangerouslySetInnerHTML",
  description:
    "dangerouslySetInnerHTML with dynamic content injects unsanitized HTML into the DOM.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-79",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      JSXAttribute(path) {
        if (
          !t.isJSXIdentifier(path.node.name, {
            name: "dangerouslySetInnerHTML",
          })
        )
          return;
        const v = path.node.value;
        if (!t.isJSXExpressionContainer(v)) return;
        const expr = v.expression;
        // { __html: "static string" } and values passed through a sanitizer
        // with verifiable import provenance are acceptable.
        const isStaticObject =
          t.isObjectExpression(expr) &&
          expr.properties.every(
            (p: any) =>
              t.isObjectProperty(p) &&
              p.key &&
              (t.isStringLiteral(p.value) || t.isNumericLiteral(p.value)),
          );
        const htmlProperty = t.isObjectExpression(expr)
          ? expr.properties.find(
              (p): p is t.ObjectProperty =>
                t.isObjectProperty(p) &&
                ((t.isIdentifier(p.key) && p.key.name === "__html") ||
                  (t.isStringLiteral(p.key) && p.key.value === "__html")),
            )
          : null;
        if (
          isStaticObject ||
          (htmlProperty && isSafeHtmlValue(htmlProperty.value, path))
        )
          return;

        const loc = nodeToLocation(path.node);
        ctx.report({
          id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:SEC-005`,
          ruleId: "SEC-005",
          cweId: "CWE-79",
          category: "SECURITY",
          severity: "HIGH",
          message: "Dynamic content passed to dangerouslySetInnerHTML.",
          explanation:
            "Dynamic HTML injected into the DOM bypasses React escaping and enables XSS.",
          loc,
          codeSnippet: extractCodeSnippet(ctx.lines, loc),
          remediation: {
            summary:
              "Sanitize the HTML with DOMPurify before injecting, or render as text content.",
            llmPromptHint:
              "Sanitize the value passed to dangerouslySetInnerHTML (e.g. DOMPurify.sanitize) or render it as escaped text.",
          },
        });
      },
    });
  },
};

function isSafeHtmlValue(value: t.Node, path: any): boolean {
  if (t.isStringLiteral(value) || t.isNumericLiteral(value)) return true;
  if (
    t.isLogicalExpression(value) &&
    (value.operator === "||" || value.operator === "??")
  ) {
    return (
      isSafeHtmlValue(value.left, path) && isSafeHtmlValue(value.right, path)
    );
  }
  if (!t.isCallExpression(value)) return false;
  const callee = value.callee;

  // Direct DOMPurify.sanitize(...).
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object, { name: "DOMPurify" }) &&
    t.isIdentifier(callee.property, { name: "sanitize" })
  ) {
    return true;
  }

  // Project wrapper imported from a sanitizer module. Requiring both a
  // sanitizer-shaped symbol and sanitizer-shaped module avoids trusting an
  // arbitrary local function solely because of its name.
  if (!t.isIdentifier(callee) || !/^sanitize(?:Html|Svg)?$/i.test(callee.name))
    return false;
  const binding = path.scope.getBinding(callee.name);
  if (
    !binding?.path?.isImportSpecifier() &&
    !binding?.path?.isImportDefaultSpecifier()
  )
    return false;
  const declaration = binding.path.parentPath;
  return (
    declaration?.isImportDeclaration() &&
    /(?:^|[/_-])sanitiz(?:e|er)(?:[/_.-]|$)/i.test(
      declaration.node.source.value,
    )
  );
}

// =========================================================================
// 10. localStorage / sessionStorage Secrets (CWE-922)
// =========================================================================
export const LocalStorageSecretsRule: VerificationRule = {
  id: "SEC-006",
  name: "Sensitive Data in Web localStorage",
  description:
    "localStorage/sessionStorage is unencrypted and readable by any script on the page (XSS exfiltration).",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-922",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      CallExpression(path) {
        const c = path.node.callee;
        if (
          !t.isMemberExpression(c) ||
          !t.isIdentifier(c.property, { name: "setItem" })
        )
          return;
        if (
          !t.isIdentifier(c.object) ||
          !/^(localStorage|sessionStorage)$/.test(c.object.name)
        )
          return;

        const [keyArg] = path.node.arguments;
        if (!t.isStringLiteral(keyArg)) return;
        const key = keyArg.value.toLowerCase();
        const sensitive = [
          "token",
          "auth",
          "jwt",
          "secret",
          "password",
          "session",
          "credential",
          "apikey",
          "api_key",
        ];
        if (!sensitive.some((kw) => key.includes(kw))) return;

        const loc = nodeToLocation(path.node);
        ctx.report({
          id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:SEC-006`,
          ruleId: "SEC-006",
          cweId: "CWE-922",
          category: "SECURITY",
          severity: "HIGH",
          message: `Sensitive key "${keyArg.value}" stored in web localStorage.`,
          explanation:
            "Any XSS on the page can read localStorage; tokens and credentials must not be stored there.",
          loc,
          codeSnippet: extractCodeSnippet(ctx.lines, loc),
          remediation: {
            summary:
              "Use httpOnly secure cookies set by the backend, or in-memory storage with silent refresh.",
            llmPromptHint:
              "Move the token out of localStorage; use httpOnly cookies from the backend or in-memory token storage.",
          },
        });
      },
    });
  },
};

// =========================================================================
// Registry
// =========================================================================
export const ALL_RULES: VerificationRule[] = [
  InsecureAsyncStorageRule,
  WebViewInjectionRule,
  InfiniteRenderLoopRule,
  ConditionalHookRule,
  HardcodedSecretsRule,
  NullDereferenceRule,
  TaintFlowRule,
  EvalRule,
  DangerousInnerHTMLRule,
  LocalStorageSecretsRule,
  ...FRAMEWORK_SECURITY_RULES,
  ...CWE_SECURITY_RULES,
  ...APPLICATION_SECURITY_RULES,
  ...CORRECTNESS_RULES,
  ...REACT_CORRECTNESS_RULES,
  ...REACT19_RULES,
  ...RELIABILITY_RULES,
  ...SEMANTIC_RULES,
  ...MOBILE_CONFIG_RULES,
  ...BACKEND_RULES,
  ...DEPLOYMENT_RULES,
  ...EXPOROUTER_RULES,
  ...NATIVE_CONSISTENCY_RULES,
  ...HYGIENE_RULES,
];
