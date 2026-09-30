import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { RuleContext, VerificationRule } from "../types/verifier";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM";

function emit(
  ctx: RuleContext,
  node: t.Node,
  ruleId: string,
  cweId: string,
  severity: Severity,
  message: string,
  explanation: string,
  remediation: string,
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    cweId,
    category: "SECURITY",
    severity,
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

function chain(node: t.Node): string[] {
  const names: string[] = [];
  let current: t.Node = node;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    const property =
      !current.computed && t.isIdentifier(current.property)
        ? current.property.name
        : current.computed && t.isStringLiteral(current.property)
          ? current.property.value
          : "<computed>";
    names.unshift(property);
    current = current.object;
  }
  if (t.isIdentifier(current)) names.unshift(current.name);
  return names;
}

function isUntrusted(
  expr: t.Node | null | undefined,
  path: NodePath,
  depth = 0,
): boolean {
  if (!expr || depth > 8) return false;
  if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
    const names = chain(expr);
    if (
      (["req", "request"].includes(names[0]) &&
        names.some((n) =>
          ["body", "query", "params", "headers"].includes(n),
        )) ||
      (names.includes("route") && names.includes("params")) ||
      names.join(".") === "process.argv" ||
      names.join(".").startsWith("process.argv.") ||
      names.join(".") === "location.href" ||
      names.join(".") === "location.search"
    )
      return true;
  }
  if (t.isIdentifier(expr)) {
    const binding = path.scope.getBinding(expr.name);
    if (!binding || !binding.constant) return false;
    const declarator = binding.path.isVariableDeclarator()
      ? binding.path
      : binding.path.parentPath?.isVariableDeclarator()
        ? binding.path.parentPath
        : null;
    if (declarator)
      return isUntrusted(declarator.node.init, binding.path, depth + 1);
  }
  if (t.isTemplateLiteral(expr))
    return expr.expressions.some((item) => isUntrusted(item, path, depth + 1));
  if (t.isBinaryExpression(expr) || t.isLogicalExpression(expr)) {
    return (
      isUntrusted(expr.left, path, depth + 1) ||
      isUntrusted(expr.right, path, depth + 1)
    );
  }
  if (t.isConditionalExpression(expr)) {
    return (
      isUntrusted(expr.consequent, path, depth + 1) ||
      isUntrusted(expr.alternate, path, depth + 1)
    );
  }
  if (
    t.isTSAsExpression(expr) ||
    t.isTSTypeAssertion(expr) ||
    t.isTSNonNullExpression(expr) ||
    t.isTSSatisfiesExpression(expr) ||
    t.isParenthesizedExpression(expr)
  ) {
    return isUntrusted(expr.expression, path, depth + 1);
  }
  return false;
}

function calleeName(callee: t.Expression | t.V8IntrinsicIdentifier): string {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee))
    return chain(callee).join(".");
  return "";
}

export const CommandInjectionRule: VerificationRule = {
  id: "SEC-007",
  name: "OS Command Injection",
  description:
    "Detects explicit external input flowing into shell-command APIs.",
  category: "SECURITY",
  defaultSeverity: "CRITICAL",
  cweId: "CWE-78",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const name = calleeName(path.node.callee);
        if (
          ![
            "exec",
            "execSync",
            "child_process.exec",
            "child_process.execSync",
            "execaCommand",
            "execaCommandSync",
          ].includes(name)
        )
          return;
        const argument = path.node.arguments[0];
        if (t.isExpression(argument) && isUntrusted(argument, path))
          emit(
            ctx,
            path.node,
            "SEC-007",
            "CWE-78",
            "CRITICAL",
            "Externally controlled input reaches an OS command string.",
            "Shell command strings interpret separators and substitutions supplied by an attacker.",
            "Avoid a shell; invoke a fixed executable with validated arguments using execFile or spawn with shell: false.",
          );
      },
    });
  },
};

export const SqlInjectionRule: VerificationRule = {
  id: "SEC-008",
  name: "SQL Injection",
  description: "Detects external input interpolated into SQL execution APIs.",
  category: "SECURITY",
  defaultSeverity: "CRITICAL",
  cweId: "CWE-89",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const name = calleeName(path.node.callee).split(".").at(-1) ?? "";
        if (
          ![
            "query",
            "execute",
            "raw",
            "$queryRawUnsafe",
            "$executeRawUnsafe",
          ].includes(name)
        )
          return;
        const sql = path.node.arguments[0];
        if (t.isExpression(sql) && isUntrusted(sql, path))
          emit(
            ctx,
            path.node,
            "SEC-008",
            "CWE-89",
            "CRITICAL",
            "Externally controlled input is incorporated into an SQL statement.",
            "The database can interpret attacker-provided SQL syntax instead of treating it solely as data.",
            "Use the driver ORM parameter API or prepared statements; never concatenate SQL values.",
          );
      },
    });
  },
};

export const SsrfRule: VerificationRule = {
  id: "SEC-009",
  name: "Server-Side Request Forgery",
  description:
    "Detects external input used directly as an outbound request URL.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-918",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const name = calleeName(path.node.callee);
        if (!(
          name === "fetch" || /^(axios|http|https)\.(get|request)$/.test(name)
        ))
          return;
        const url = path.node.arguments[0];
        if (t.isExpression(url) && isUntrusted(url, path))
          emit(
            ctx,
            path.node,
            "SEC-009",
            "CWE-918",
            "HIGH",
            "Externally controlled URL reaches an outbound request.",
            "An attacker-controlled destination can make the server access internal services, metadata endpoints, or unexpected protocols.",
            "Parse the URL and enforce an allowlist of HTTPS origins; reject credentials, redirects, and private/link-local addresses.",
          );
      },
    });
  },
};

const FILE_APIS = new Set([
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "unlink",
  "unlinkSync",
  "createReadStream",
  "createWriteStream",
  "readdir",
  "readdirSync",
  "stat",
  "statSync",
]);
export const PathTraversalRule: VerificationRule = {
  id: "SEC-010",
  name: "Path Traversal",
  description: "Detects external input used directly as a filesystem path.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-22",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const name = calleeName(path.node.callee).split(".").at(-1) ?? "";
        if (!FILE_APIS.has(name)) return;
        const file = path.node.arguments[0];
        if (t.isExpression(file) && isUntrusted(file, path))
          emit(
            ctx,
            path.node,
            "SEC-010",
            "CWE-22",
            "HIGH",
            "Externally controlled input is used as a filesystem path.",
            "Parent segments or absolute paths can escape the intended storage directory.",
            "Resolve against a fixed base directory, reject absolute/parent traversal, and verify the resolved path remains inside the base.",
          );
      },
    });
  },
};

const SECURITY_CONTEXT =
  /password|passwd|token|otp|pin|session|secret|nonce|csrf|reset|verification|auth|api.?key/i;
function hasSecurityContext(path: NodePath): boolean {
  const fn = path.getFunctionParent();
  if (fn) {
    const node = fn.node;
    if (
      t.isFunctionDeclaration(node) &&
      node.id &&
      SECURITY_CONTEXT.test(node.id.name)
    )
      return true;
    const parent = fn.parentPath?.node;
    if (
      t.isVariableDeclarator(parent) &&
      t.isIdentifier(parent.id) &&
      SECURITY_CONTEXT.test(parent.id.name)
    )
      return true;
  }
  const declarator = path.findParent((candidate) =>
    candidate.isVariableDeclarator(),
  );
  if (!declarator || !t.isVariableDeclarator(declarator.node)) return false;
  return (
    t.isIdentifier(declarator.node.id) &&
    SECURITY_CONTEXT.test(declarator.node.id.name)
  );
}

export const WeakCryptoRule: VerificationRule = {
  id: "SEC-011",
  name: "Weak Cryptography in Security Context",
  description:
    "Detects Math.random and broken hashes used for security-sensitive values.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-338",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (!hasSecurityContext(path)) return;
        const name = calleeName(path.node.callee);
        if (name === "Math.random")
          emit(
            ctx,
            path.node,
            "SEC-011",
            "CWE-338",
            "HIGH",
            "Math.random() is used to generate a security-sensitive value.",
            "Math.random is predictable and is not a cryptographically secure random number generator.",
            "Use crypto.randomInt, crypto.randomBytes, crypto.randomUUID, or crypto.getRandomValues.",
          );
        if (
          /(^|\.)createHash$/.test(name) &&
          t.isStringLiteral(path.node.arguments[0]) &&
          /^(md4|md5|sha1)$/i.test(path.node.arguments[0].value)
        )
          emit(
            ctx,
            path.node,
            "SEC-011",
            "CWE-328",
            "HIGH",
            `Weak hash '${path.node.arguments[0].value}' is used in a security-sensitive context.`,
            "MD4, MD5, and SHA-1 are broken for security decisions and password storage.",
            "Use an appropriate modern construction such as Argon2/scrypt for passwords or SHA-256/HMAC for integrity.",
          );
      },
    });
  },
};

export const PrototypePollutionRule: VerificationRule = {
  id: "SEC-012",
  name: "Prototype Pollution",
  description:
    "Detects externally controlled keys written into ordinary objects.",
  category: "SECURITY",
  defaultSeverity: "HIGH",
  cweId: "CWE-1321",
  check(ctx) {
    traverse(ctx.ast, {
      AssignmentExpression(path) {
        const left = path.node.left;
        if (
          !t.isMemberExpression(left) ||
          !left.computed ||
          !t.isExpression(left.property) ||
          !isUntrusted(left.property, path)
        )
          return;
        emit(
          ctx,
          path.node,
          "SEC-012",
          "CWE-1321",
          "HIGH",
          "Externally controlled property name is written to an object.",
          "Keys such as __proto__, constructor, or prototype can mutate inherited behavior and affect unrelated objects.",
          "Reject dangerous keys and store untrusted key/value data in a Map or Object.create(null).",
        );
      },
    });
  },
};

export const CWE_SECURITY_RULES: VerificationRule[] = [
  CommandInjectionRule,
  SqlInjectionRule,
  SsrfRule,
  PathTraversalRule,
  WeakCryptoRule,
  PrototypePollutionRule,
];
