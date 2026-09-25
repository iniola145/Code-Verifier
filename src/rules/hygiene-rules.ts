import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { VerificationRule, RuleContext } from "../types/verifier";
import { nodeToLocation, extractCodeSnippet } from "../parser/ast";
import { collectJsxIdentifierNames } from "./react-correctness-rules";

// =========================================================================
// Hygiene rules: low-noise, LOW-severity advisories. They never fail a run.
// =========================================================================

// -------------------------------------------------------------------------
// 1. `target="_blank"` without rel="noopener" (reverse tabnabbing).
// -------------------------------------------------------------------------
export const TargetBlankRule: VerificationRule = {
  id: "WEB-001",
  name: 'target="_blank" without rel="noopener"',
  description:
    "Links opening a new tab can access window.opener and redirect the origin page (reverse tabnabbing). Modern browsers imply noopener, so this is advisory; older in-app WebViews are not.",
  category: "SECURITY",
  defaultSeverity: "LOW",
  cweId: "CWE-1022",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      JSXElement(path) {
        const opening = path.node.openingElement;
        const attrs = opening.attributes.filter(t.isJSXAttribute);
        const target = attrs.find((a) =>
          t.isJSXIdentifier(a.name, { name: "target" }),
        );
        const targetValue =
          target && t.isStringLiteral(target.value)
            ? target.value.value
            : target &&
                t.isJSXExpressionContainer(target.value) &&
                t.isStringLiteral(target.value.expression)
              ? target.value.expression.value
              : null;
        if (targetValue !== "_blank") return;

        const rel = attrs.find((a) =>
          t.isJSXIdentifier(a.name, { name: "rel" }),
        );
        const relValue =
          rel && t.isStringLiteral(rel.value)
            ? rel.value.value
            : rel &&
                t.isJSXExpressionContainer(rel.value) &&
                t.isStringLiteral(rel.value.expression)
              ? rel.value.expression.value
              : "";
        if (relValue.split(/\s+/).includes("noopener")) return;

        const loc = nodeToLocation(path.node);
        ctx.report({
          id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:WEB-001`,
          ruleId: "WEB-001",
          cweId: "CWE-1022",
          category: "SECURITY",
          severity: "LOW",
          message:
            'target="_blank" without rel="noopener" (reverse tabnabbing risk).',
          explanation:
            "The opened page can set window.opener.location to phish the user on the original tab. Modern browsers imply noopener; older in-app WebViews may not.",
          loc,
          codeSnippet: extractCodeSnippet(ctx.lines, loc),
          remediation: {
            summary: 'Add rel="noopener noreferrer" to the link.',
            suggestedFix: 'rel="noopener noreferrer"',
            llmPromptHint:
              'Add rel="noopener noreferrer" alongside target="_blank".',
          },
        });
      },
    });
  },
};

// -------------------------------------------------------------------------
// 2. `debugger` statement left in code (CWE-489).
// -------------------------------------------------------------------------
export const DebuggerRule: VerificationRule = {
  id: "HYG-001",
  name: "Debugger Statement",
  description:
    "A `debugger` statement left in shipped code pauses execution in any attached devtools.",
  category: "CORRECTNESS",
  defaultSeverity: "LOW",
  cweId: "CWE-489",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      DebuggerStatement(path) {
        const loc = nodeToLocation(path.node);
        ctx.report({
          id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:HYG-001`,
          ruleId: "HYG-001",
          cweId: "CWE-489",
          category: "CORRECTNESS",
          severity: "LOW",
          message: "debugger statement left in code.",
          explanation:
            "In production builds this pauses execution when devtools are attached; in dev it is almost always a leftover debugging aid.",
          loc,
          codeSnippet: extractCodeSnippet(ctx.lines, loc),
          remediation: {
            summary: "Remove the debugger statement.",
            llmPromptHint: "Delete the debugger statement before shipping.",
          },
        });
      },
    });
  },
};

// -------------------------------------------------------------------------
// 3. Insecure http:// URLs (CWE-319) — advisory; only URL-bearing contexts.
// -------------------------------------------------------------------------
const HTTP_HOST_EXEMPT = [
  /^localhost(?::|$)/,
  /^127\./,
  /^0\.0\.0\.0/,
  /^10\./,
  /^192\.168\./,
  /^[^.]+$/, // bare single-label host (dev gateways)
  /example\.(com|org)$/,
];

const URL_BEARING_ATTRS = new Set([
  "src",
  "href",
  "uri",
  "url",
  "endpoint",
  "baseURL",
  "baseUrl",
  "server",
  "apiUrl",
  "api_url",
  "source",
  "link",
]);

const URLISH_VAR = /url|uri|host|endpoint|base|server|api/i;

export const InsecureHttpUrlRule: VerificationRule = {
  id: "NET-001",
  name: "Insecure HTTP URL",
  description:
    "Cleartext http:// URLs can be read or modified in transit; iOS ATS blocks them by default and Android blocks cleartext since API 28. Only URL-bearing contexts are flagged to keep noise down.",
  category: "SECURITY",
  defaultSeverity: "LOW",
  cweId: "CWE-319",
  check: (ctx: RuleContext) => {
    traverse(ctx.ast, {
      StringLiteral(path) {
        const value = path.node.value;
        if (!value.startsWith("http://")) return;
        if (/w3\.org|dublincore|schema/i.test(value)) return;
        const host = value.slice(7).split(/[/?#]/)[0];
        if (HTTP_HOST_EXEMPT.some((re) => re.test(host))) return;

        const parent = path.parent;
        const inUrlContext =
          (t.isJSXAttribute(parent) &&
            t.isJSXIdentifier(parent.name) &&
            URL_BEARING_ATTRS.has(parent.name.name)) ||
          (t.isVariableDeclarator(parent) &&
            t.isIdentifier(parent.id) &&
            URLISH_VAR.test(parent.id.name)) ||
          (t.isObjectProperty(parent) &&
            t.isIdentifier(parent.key) &&
            URLISH_VAR.test(parent.key.name)) ||
          (t.isAssignmentExpression(parent) &&
            t.isIdentifier(parent.left) &&
            URLISH_VAR.test(parent.left.name)) ||
          (t.isCallExpression(parent) && parent.arguments.includes(path.node));
        if (!inUrlContext) return;

        const loc = nodeToLocation(path.node);
        ctx.report({
          id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:NET-001`,
          ruleId: "NET-001",
          cweId: "CWE-319",
          category: "SECURITY",
          severity: "LOW",
          message: `Insecure http:// URL '${value}'.`,
          explanation:
            "Cleartext HTTP can be read or modified in transit. iOS ATS blocks http by default; Android blocks cleartext by default since API 28 — an http URL signals either a bypass or a bug.",
          loc,
          codeSnippet: extractCodeSnippet(ctx.lines, loc),
          remediation: {
            summary: "Use https:// for this URL.",
            suggestedFix: value.replace("http://", "https://"),
            llmPromptHint: `Replace '${value}' with '${value.replace("http://", "https://")}'.`,
          },
        });
      },
    });
  },
};

// -------------------------------------------------------------------------
// 4. Unused local declarations (dead code / forgotten wiring).
// -------------------------------------------------------------------------
export const UnusedLocalRule: VerificationRule = {
  id: "HYG-002",
  name: "Unused Local Declaration",
  description:
    "Detects const/let declarations and function declarations that are never referenced afterwards, or that are assigned but never read. Exports, destructuring patterns, and _-prefixed names are exempt.",
  category: "CORRECTNESS",
  defaultSeverity: "LOW",
  check: (ctx: RuleContext) => {
    const jsxNames = collectJsxIdentifierNames(ctx);
    const exportNames = new Set<string>();
    traverse(ctx.ast, {
      ExportSpecifier(path) {
        exportNames.add(path.node.local.name);
      },
    });

    const report = (
      node: t.Node,
      message: string,
      explanation: string,
      remediation: string,
    ): void => {
      const loc = nodeToLocation(node);
      ctx.report({
        id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:HYG-002`,
        ruleId: "HYG-002",
        category: "CORRECTNESS",
        severity: "LOW",
        message,
        explanation,
        loc,
        codeSnippet: extractCodeSnippet(ctx.lines, loc),
        remediation: { summary: remediation, llmPromptHint: remediation },
      });
    };
    // Only a declaration that is the export statement's DIRECT child is
    // exported; anything merely nested inside an exported component still
    // has all of its references in-file.
    const isDirectlyExported = (path: NodePath<t.Node>): boolean => {
      const parent = path.parentPath;
      return (
        !!parent &&
        (parent.isExportNamedDeclaration() ||
          parent.isExportDefaultDeclaration())
      );
    };

    traverse(ctx.ast, {
      VariableDeclarator(path) {
        const { id, init } = path.node;
        if (!t.isIdentifier(id) || id.name.startsWith("_")) return;
        // useState pairs are REACT-008's domain; destructuring patterns are exempt.
        if (
          t.isCallExpression(init) &&
          (t.isIdentifier(init.callee, { name: "useState" }) ||
            (t.isMemberExpression(init.callee) &&
              t.isIdentifier(init.callee.property, { name: "useState" })))
        )
          return;
        if ((path.parentPath.node as unknown as { declare?: boolean }).declare)
          return;
        if (
          isDirectlyExported(path.parentPath) ||
          exportNames.has(id.name) ||
          jsxNames.has(id.name)
        )
          return;
        const binding = path.scope.getBinding(id.name);
        if (!binding || binding.references !== 0) return;

        if (binding.constantViolations.length > 0) {
          report(
            path.node,
            `Local variable '${id.name}' is assigned but its value is never read.`,
            "Every assignment to it is wasted work, and the value it holds is a silent dead end — often a computed result that was meant to be returned, rendered, or checked but never was.",
            "Remove the variable, or return/render/check it where the computed value was intended to be used.",
          );
        } else {
          report(
            path.node,
            `Local declaration '${id.name}' is never used.`,
            "It is initialized and never referenced afterwards — a leftover, or a sign that a value was computed but never wired into the logic that needed it.",
            "Remove the declaration, or use it where the value was intended to matter.",
          );
        }
      },
      FunctionDeclaration(path) {
        const { id, body } = path.node;
        if (!id || id.name.startsWith("_") || !body) return;
        if (path.node.declare) return;
        // Non-exported top-level components are commonly invoked by the
        // framework (routes, screens, entry points) rather than in-file.
        if (t.isProgram(path.parent) && /^[A-Z]/.test(id.name)) return;
        if (
          isDirectlyExported(path) ||
          exportNames.has(id.name) ||
          jsxNames.has(id.name)
        )
          return;
        const binding = path.scope.getBinding(id.name);
        if (!binding || binding.references !== 0) return;
        report(
          path.node,
          `Function '${id.name}' is declared but never called.`,
          "Nothing references it — dead code that still has to be read, maintained, and bundled. If it is meant to be this file's public API, export it; otherwise it is a leftover.",
          "Remove the function, export it if it is part of the file's API, or call it where it was intended to run.",
        );
      },
    });
  },
};

// -------------------------------------------------------------------------
// 4. Unused imports.
// -------------------------------------------------------------------------
export const UnusedImportRule: VerificationRule = {
  id: "HYG-003",
  name: "Unused Import",
  description:
    "Detects imported symbols that are never referenced in the importing file. Side-effect imports, re-exports, and _-prefixed names are exempt.",
  category: "CORRECTNESS",
  defaultSeverity: "LOW",
  check: (ctx: RuleContext) => {
    const jsxNames = collectJsxIdentifierNames(ctx);
    // Babel bindings do not count identifiers that occur only in TypeScript
    // syntax (for example `Foo` in `value: Foo`). Keep a conservative set of
    // every identifier nested beneath a TS node so those imports are not
    // misreported as unused.
    const typeNames = new Set<string>();
    traverse(ctx.ast, {
      Identifier(path) {
        if (path.findParent((parent) => parent.node.type.startsWith("TS"))) {
          typeNames.add(path.node.name);
        }
      },
    });
    // `export { X } from "./y"` and `export * from "./y"` consume the source
    // module's bindings without local references, so treat those names as used.
    const reExportedNames = new Set<string>();
    traverse(ctx.ast, {
      ExportNamedDeclaration(path) {
        if (path.node.source) {
          for (const spec of path.node.specifiers) {
            if (
              t.isExportSpecifier(spec) &&
              t.isIdentifier(spec.local, { name: "default" })
            ) {
              // `export { default } from "./y"` — no local name to track.
              continue;
            }
            if (t.isExportSpecifier(spec) && t.isIdentifier(spec.local))
              reExportedNames.add(spec.local.name);
          }
        }
      },
      ExportAllDeclaration(path) {
        // `export * from "./y"` pulls in everything; the declaration itself is
        // the only consumer, so the source is covered by HYG-004's graph.
      },
    });

    const report = (node: t.Node, name: string, kind: string): void => {
      const loc = nodeToLocation(node);
      ctx.report({
        id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:HYG-003`,
        ruleId: "HYG-003",
        category: "CORRECTNESS",
        severity: "LOW",
        message: `Imported ${kind} '${name}' is never used in this file.`,
        explanation:
          "The import adds a dependency edge and a name to the file's scope without contributing anything — dead weight that bundlers tree-shake only sometimes, and readers always pay for.",
        loc,
        codeSnippet: extractCodeSnippet(ctx.lines, loc),
        remediation: {
          summary: `Remove the import of '${name}', or use it where it was intended.`,
          llmPromptHint: `Remove the unused import of '${name}' from this file, or wire it into the logic that needed it.`,
        },
      });
    };

    traverse(ctx.ast, {
      ImportDeclaration(path) {
        // Type-only imports are exempt: babel's binding reference counts do
        // not include type-annotation positions, so any reference check would
        // produce false positives (e.g. `UseFormRegister<T>` in a props type).
        if (path.node.importKind === "type") return;
        const source = t.isStringLiteral(path.node.source)
          ? path.node.source.value
          : "";
        // `import React from "react"` is exempt: whether the classic or
        // automatic JSX runtime is in use is not visible to a syntax-only
        // parse, so stay quiet on the React default import.
        const isReactDefault =
          /^react$/.test(source) &&
          path.node.specifiers.some(
            (s) => t.isImportDefaultSpecifier(s) && s.local.name === "React",
          );
        if (isReactDefault) return;
        for (const spec of path.node.specifiers) {
          // Inline type specifiers (`import { type Foo }`) are exempt for the
          // same reason as whole type-only imports: babel's reference counts
          // miss type-annotation positions.
          if (t.isImportSpecifier(spec) && spec.importKind === "type") continue;
          const name = spec.local.name;
          if (name.startsWith("_")) continue;
          if (
            reExportedNames.has(name) ||
            jsxNames.has(name) ||
            typeNames.has(name)
          )
            continue;
          const binding = path.scope.getBinding(name);
          if (!binding || binding.references !== 0) continue;
          const kind = t.isImportDefaultSpecifier(spec)
            ? "default"
            : t.isImportNamespaceSpecifier(spec)
              ? "namespace"
              : "symbol";
          report(spec, name, kind);
        }
      },
    });
  },
};

export const HYGIENE_RULES: VerificationRule[] = [
  TargetBlankRule,
  DebuggerRule,
  InsecureHttpUrlRule,
  UnusedLocalRule,
  UnusedImportRule,
];
