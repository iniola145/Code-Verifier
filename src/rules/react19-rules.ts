import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";

// =========================================================================
// React 19 upgrade rules: APIs and behaviors removed or changed by React 19
// (react.dev upgrade guide, React 19.0 changelog). Every rule flags a form
// the React 19 codemod preset (`react-19`) also migrates.
// =========================================================================

function emit(
  ctx: RuleContext,
  node: t.Node,
  ruleId: string,
  severity: "HIGH" | "MEDIUM" | "LOW",
  message: string,
  explanation: string,
  remediation: string,
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    category: "REACT_HOOKS",
    severity,
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

interface ModuleImports {
  /** Local names bound to a whole module (default or namespace import) -> module specifier. */
  namespaces: Map<string, string>;
  /** Local names of named imports -> { module, imported name }. */
  named: Map<string, { module: string; imported: string }>;
}

/** Collect local import bindings whose module specifier is in `modules`. */
function importsFrom(ctx: RuleContext, modules: Set<string>): ModuleImports {
  const result: ModuleImports = { namespaces: new Map(), named: new Map() };
  traverse(ctx.ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      if (typeof source !== "string" || !modules.has(source)) return;
      for (const spec of path.node.specifiers) {
        if (
          spec.type === "ImportDefaultSpecifier" ||
          spec.type === "ImportNamespaceSpecifier"
        ) {
          result.namespaces.set(spec.local.name, source);
        } else if (spec.type === "ImportSpecifier") {
          const imported = t.isIdentifier(spec.imported)
            ? spec.imported.name
            : spec.imported.value;
          result.named.set(spec.local.name, { module: source, imported });
        }
      }
    },
  });
  return result;
}

/** True when the identifier's binding is an import (not a local shadow). */
function isImportBinding(
  path: NodePath<t.CallExpression>,
  name: string,
): boolean {
  const binding = path.scope.getBinding(name);
  return !binding || binding.kind === "module";
}

// -------------------------------------------------------------------------
// REACT-009: ReactDOM / ReactDOMServer APIs removed in React 19.
// -------------------------------------------------------------------------
const REMOVED_DOM_APIS: Record<string, string> = {
  render: "createRoot(container).render(<App />) from react-dom/client",
  hydrate: "hydrateRoot(container, <App />) from react-dom/client",
  unmountComponentAtNode: "root.unmount() on a root from react-dom/client",
  findDOMNode:
    "a ref to the DOM node (useRef + ref.current, or a callback ref)",
  unstable_renderSubtreeIntoContainer: "createRoot from react-dom/client",
};
const REMOVED_SERVER_APIS: Record<string, string> = {
  renderToNodeStream:
    "renderToPipeableStream (Node.js) or renderToReadableStream (edge runtimes)",
  renderToStaticNodeStream:
    "renderToPipeableStream (Node.js) or renderToReadableStream (edge runtimes)",
  hydrateToNodeStream:
    "renderToPipeableStream (Node.js) or renderToReadableStream (edge runtimes)",
};

export const RemovedReactDomApisRule: VerificationRule = {
  id: "REACT-009",
  name: "Removed ReactDOM API",
  description:
    "Detects calls to ReactDOM.render, ReactDOM.hydrate, ReactDOM.unmountComponentAtNode, ReactDOM.findDOMNode, and the react-dom/server node-stream renderers — all removed in React 19.",
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
  check(ctx) {
    const imports = importsFrom(
      ctx,
      new Set(["react-dom", "react-dom/server"]),
    );
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        let api: string | null = null;
        let label: string | null = null;
        if (
          t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object) &&
          !callee.computed
        ) {
          const module = imports.namespaces.get(callee.object.name);
          const prop = t.isIdentifier(callee.property)
            ? callee.property.name
            : null;
          if (module && prop) {
            if (module === "react-dom" && REMOVED_DOM_APIS[prop]) {
              api = prop;
              label = `ReactDOM.${prop}`;
            } else if (
              module === "react-dom/server" &&
              REMOVED_SERVER_APIS[prop]
            ) {
              api = prop;
              label = `ReactDOMServer.${prop}`;
            }
          }
        } else if (
          t.isIdentifier(callee) &&
          isImportBinding(path, callee.name)
        ) {
          const entry = imports.named.get(callee.name);
          if (
            entry?.module === "react-dom" &&
            REMOVED_DOM_APIS[entry.imported]
          ) {
            api = entry.imported;
            label = `ReactDOM.${entry.imported}`;
          } else if (
            entry?.module === "react-dom/server" &&
            REMOVED_SERVER_APIS[entry.imported]
          ) {
            api = entry.imported;
            label = `ReactDOMServer.${entry.imported}`;
          }
        }
        if (!api || !label) return;
        const replacement = (REMOVED_DOM_APIS[api] ??
          REMOVED_SERVER_APIS[api]) as string;
        emit(
          ctx,
          path.node,
          "REACT-009",
          "HIGH",
          `${label}(...) was removed in React 19.`,
          `${label} was deprecated in React 18 and removed in React 19 — calling it throws at runtime.`,
          `Migrate to ${replacement}.`,
        );
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-010: React.createFactory (removed in React 19).
// -------------------------------------------------------------------------
export const CreateFactoryRule: VerificationRule = {
  id: "REACT-010",
  name: "React.createFactory Removed",
  description:
    "Detects calls to React.createFactory, which React 19 removed — plain JSX is the replacement.",
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
  check(ctx) {
    const react = importsFrom(ctx, new Set(["react"]));
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        const isMember =
          t.isMemberExpression(callee) &&
          !callee.computed &&
          t.isIdentifier(callee.object) &&
          react.namespaces.has(callee.object.name) &&
          t.isIdentifier(callee.property, { name: "createFactory" });
        const isNamed =
          t.isIdentifier(callee) &&
          isImportBinding(path, callee.name) &&
          react.named.get(callee.name)?.imported === "createFactory";
        if (!isMember && !isNamed) return;
        emit(
          ctx,
          path.node,
          "REACT-010",
          "HIGH",
          "React.createFactory(...) was removed in React 19.",
          "createFactory was deprecated in React 16.13 and removed in React 19 — calling it throws at runtime.",
          "Render plain JSX instead (e.g. <button /> rather than createFactory('button')(...)).",
        );
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-011: String refs (removed in React 19).
// -------------------------------------------------------------------------
export const StringRefRule: VerificationRule = {
  id: "REACT-011",
  name: "String Ref",
  description:
    'Detects string refs on JSX elements (ref="name"), which React 19 removed.',
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      JSXAttribute(path) {
        if (!t.isJSXIdentifier(path.node.name, { name: "ref" })) return;
        const value = path.node.value;
        const inner = t.isStringLiteral(value)
          ? value
          : t.isJSXExpressionContainer(value) &&
              t.isStringLiteral(value.expression)
            ? value.expression
            : null;
        if (!inner) return;
        const name = inner.value;
        emit(
          ctx,
          path.node,
          "REACT-011",
          "HIGH",
          `String ref '${name}' was removed in React 19.`,
          "String refs were deprecated in React 16.3 and removed in React 19 — React no longer wires this.string refs up, so the ref never resolves.",
          "Use a ref object (useRef) or a callback ref instead, e.g. ref={(node) => { this.input = node; }}.",
        );
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-012: Legacy Context (contextTypes / childContextTypes /
// getChildContext — removed in React 19).
// -------------------------------------------------------------------------
const LEGACY_CONTEXT_MEMBERS = new Set([
  "contextTypes",
  "childContextTypes",
  "getChildContext",
]);

export const LegacyContextRule: VerificationRule = {
  id: "REACT-012",
  name: "Legacy Context API",
  description:
    "Detects legacy context members (contextTypes, childContextTypes, getChildContext), which React 19 removed in favor of React.createContext.",
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      "ClassProperty|ClassMethod"(path) {
        const key = (path.node as t.ClassProperty | t.ClassMethod).key;
        const name = t.isIdentifier(key)
          ? key.name
          : t.isStringLiteral(key)
            ? key.value
            : null;
        if (!name || !LEGACY_CONTEXT_MEMBERS.has(name)) return;
        emit(
          ctx,
          path.node,
          "REACT-012",
          "HIGH",
          `Legacy Context member '${name}' was removed in React 19.`,
          "The legacy context API (contextTypes / childContextTypes / getChildContext) was deprecated in React 16.6 and removed in React 19 — context read through it is always undefined.",
          "Migrate to React.createContext with a static contextType on classes, or useContext in function components.",
        );
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-013: defaultProps on function components (removed in React 19;
// class components continue to support it).
// -------------------------------------------------------------------------
export const FunctionDefaultPropsRule: VerificationRule = {
  id: "REACT-013",
  name: "defaultProps on Function Component",
  description:
    "Detects X.defaultProps assignments where X resolves to a function declared in this file — React 19 removed defaultProps for function components; class components are exempt.",
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      AssignmentExpression(path) {
        const { left, right } = path.node;
        if (
          !t.isMemberExpression(left) ||
          left.computed ||
          !t.isIdentifier(left.object) ||
          !t.isIdentifier(left.property, { name: "defaultProps" })
        )
          return;
        if (!/^[A-Z]/.test(left.object.name)) return;
        const binding = path.scope.getBinding(left.object.name);
        if (!binding) return; // imported / external — cannot prove it is a function
        const bp = binding.path;
        const isFunctionComponent =
          bp.isFunctionDeclaration() ||
          (bp.isVariableDeclarator() &&
            !!bp.node.init &&
            t.isFunction(bp.node.init));
        if (!isFunctionComponent) return; // classes keep defaultProps in React 19
        emit(
          ctx,
          path.node,
          "REACT-013",
          "HIGH",
          `defaultProps on function component '${left.object.name}' no longer works in React 19.`,
          "React 19 removed defaultProps for function components — the defaults are silently ignored and props arrive undefined.",
          `Use ES6 default parameters instead: function ${left.object.name}({ size = 1 }) { ... }.`,
        );
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-014: propTypes (no longer checked in React 19 — silently ignored).
// -------------------------------------------------------------------------
export const PropTypesIgnoredRule: VerificationRule = {
  id: "REACT-014",
  name: "propTypes No Longer Checked",
  description:
    "Detects propTypes assignments or class properties — React 19 no longer validates propTypes, so the checks silently disappear.",
  category: "REACT_HOOKS",
  defaultSeverity: "LOW",
  check(ctx) {
    traverse(ctx.ast, {
      "ClassProperty|AssignmentExpression"(path) {
        let objectName: string | null = null;
        if (path.node.type === "ClassProperty") {
          const key = (path.node as t.ClassProperty).key;
          if (!t.isIdentifier(key, { name: "propTypes" })) return;
        } else {
          const left = (path.node as t.AssignmentExpression).left;
          if (
            !t.isMemberExpression(left) ||
            left.computed ||
            !t.isIdentifier(left.object) ||
            !t.isIdentifier(left.property, { name: "propTypes" })
          )
            return;
          objectName = left.object.name;
          if (!/^[A-Z]/.test(objectName)) return;
          const binding = path.scope.getBinding(objectName);
          if (!binding) return; // external — leave to library authors
        }
        emit(
          ctx,
          path.node,
          "REACT-014",
          "LOW",
          objectName
            ? `propTypes on '${objectName}' are ignored in React 19.`
            : "propTypes are ignored in React 19.",
          "React 19 removed propTypes checking entirely — the declarations remain but no validation ever runs, so invalid props pass silently.",
          "Move the constraints into TypeScript types (or a runtime schema validator) and delete the propTypes.",
        );
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-015: useRef() without an initial argument (React 19 types require
// one, and .current would be undefined).
// -------------------------------------------------------------------------
export const UseRefRequiresArgumentRule: VerificationRule = {
  id: "REACT-015",
  name: "useRef Without Argument",
  description:
    "Detects useRef() calls with no initial value — React 19's types require an argument and the ref's .current would be undefined.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    const react = importsFrom(ctx, new Set(["react"]));
    traverse(ctx.ast, {
      CallExpression(path) {
        if (path.node.arguments.length !== 0) return;
        const callee = path.node.callee;
        const bareUseRef =
          t.isIdentifier(callee, { name: "useRef" }) &&
          isImportBinding(path, "useRef");
        const reactUseRef =
          t.isMemberExpression(callee) &&
          !callee.computed &&
          t.isIdentifier(callee.object) &&
          react.namespaces.has(callee.object.name) &&
          t.isIdentifier(callee.property, { name: "useRef" });
        if (!bareUseRef && !reactUseRef) return;
        emit(
          ctx,
          path.node,
          "REACT-015",
          "MEDIUM",
          "useRef() called without an initial value.",
          "React 19 requires useRef to take an initial argument (a type error under @types/react 19); at runtime the ref's .current would start as undefined.",
          "Pass an initial value — useRef(null) for DOM refs, or the real initial value for state-like refs.",
        );
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-016: use(...) inside try/catch (React throws
// "Hooks cannot be called inside try clauses").
// -------------------------------------------------------------------------
export const UseInTryRule: VerificationRule = {
  id: "REACT-016",
  name: "use() Inside try/catch",
  description:
    'Detects the React `use` hook called inside a try clause — React throws "Hooks cannot be called inside try clauses" at runtime.',
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
  check(ctx) {
    const react = importsFrom(ctx, new Set(["react"]));
    const useLocals = new Set<string>();
    for (const [local, entry] of react.named) {
      if (entry.imported === "use") useLocals.add(local);
    }
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        const isUse =
          (t.isIdentifier(callee) &&
            useLocals.has(callee.name) &&
            isImportBinding(path, callee.name)) ||
          (t.isMemberExpression(callee) &&
            !callee.computed &&
            t.isIdentifier(callee.object) &&
            react.namespaces.has(callee.object.name) &&
            t.isIdentifier(callee.property, { name: "use" }));
        if (!isUse) return;
        let ancestor: NodePath | null = path.parentPath;
        while (ancestor) {
          if (ancestor.isTryStatement()) {
            emit(
              ctx,
              path.node,
              "REACT-016",
              "HIGH",
              "use(...) cannot be called inside a try clause.",
              'React throws "Hooks cannot be called inside try clauses" — use() may suspend or throw, which try/catch would swallow and corrupt hook bookkeeping.',
              "Move the try/catch inside the code that consumes the resolved value, or handle rejection where the promise is created; use error boundaries for render-time failures.",
            );
            return;
          }
          ancestor = ancestor.parentPath;
        }
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-017: callback ref returning a non-function value (React 19 cleanup
// semantics — the return value must be a cleanup function or nothing).
// -------------------------------------------------------------------------
/** The parser retains parentheses — unwrap them before classification. */
function unwrapParens(node: t.Node): t.Node {
  let current = node;
  while (t.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Expressions whose value is provably not a function and not void. */
function isNonVoidValue(node: t.Node): boolean {
  return (
    t.isAssignmentExpression(node) ||
    t.isIdentifier(node) ||
    t.isMemberExpression(node) ||
    t.isObjectExpression(node) ||
    t.isArrayExpression(node) ||
    t.isTemplateLiteral(node) ||
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isJSXElement(node)
  );
}

function isCleanupLike(node: t.Node): boolean {
  return (
    t.isUnaryExpression(node, { operator: "void" }) ||
    t.isFunction(node) ||
    t.isIdentifier(node, { name: "undefined" }) ||
    t.isNullLiteral(node) ||
    t.isCallExpression(node) // may return void; leave to TypeScript
  );
}

export const RefCallbackReturnRule: VerificationRule = {
  id: "REACT-017",
  name: "Callback Ref Returns a Value",
  description:
    "Detects callback refs that implicitly return a value — React 19 treats a callback ref's return value as a cleanup function, and returning anything that is not a function is rejected.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      JSXAttribute(path) {
        if (!t.isJSXIdentifier(path.node.name, { name: "ref" })) return;
        const value = path.node.value;
        if (!t.isJSXExpressionContainer(value)) return;
        const expr = value.expression;
        if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr))
          return;

        if (
          t.isArrowFunctionExpression(expr) &&
          !t.isBlockStatement(expr.body)
        ) {
          if (!isNonVoidValue(unwrapParens(expr.body))) return;
          emit(
            ctx,
            path.node,
            "REACT-017",
            "MEDIUM",
            "Callback ref implicitly returns a value.",
            "React 19 uses a callback ref's return value as its cleanup function — returning the node or an assignment result (anything that is not a function) is rejected.",
            "Wrap the body in braces: ref={(el) => { this.input = el; }}.",
          );
          return;
        }

        // Block body: only return statements that belong to THIS function.
        const returns: t.ReturnStatement[] = [];
        const walk = (node: t.Node | null | undefined): void => {
          if (!node || !node.type) return;
          if (node !== expr.body && t.isFunction(node)) return;
          if (t.isReturnStatement(node)) {
            returns.push(node);
            return;
          }
          for (const key of t.VISITOR_KEYS[node.type] ?? []) {
            const child = (node as unknown as Record<string, unknown>)[key];
            if (Array.isArray(child)) child.forEach((c) => walk(c as t.Node));
            else walk(child as t.Node);
          }
        };
        walk(expr.body);
        for (const ret of returns) {
          const arg = ret.argument ? unwrapParens(ret.argument) : null;
          if (!arg || isCleanupLike(arg)) continue;
          if (!isNonVoidValue(arg)) continue;
          emit(
            ctx,
            ret,
            "REACT-017",
            "MEDIUM",
            "Callback ref returns a value that is not a cleanup function.",
            "React 19 uses a callback ref's return value as its cleanup function — returning the node or a value is rejected.",
            "Return nothing (drop the return), or return a cleanup function: ref={(el) => { this.input = el; }}.",
          );
        }
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-018: react-dom/test-utils (removed in React 19; act moved to
// React.act, the rest to Testing Library).
// -------------------------------------------------------------------------
export const TestUtilsRemovedRule: VerificationRule = {
  id: "REACT-018",
  name: "react-dom/test-utils Removed",
  description:
    "Detects imports from react-dom/test-utils, which React 19 removed — act moved to React.act and the remaining utilities to Testing Library.",
  category: "REACT_HOOKS",
  defaultSeverity: "LOW",
  check(ctx) {
    traverse(ctx.ast, {
      ImportDeclaration(path) {
        if (path.node.source.value !== "react-dom/test-utils") return;
        emit(
          ctx,
          path.node,
          "REACT-018",
          "LOW",
          "react-dom/test-utils was removed in React 19.",
          "All react-dom/test-utils exports were removed in React 19 — act now lives on React itself (React.act) and the remaining helpers moved to @testing-library/react.",
          "Import act from 'react' (or from @testing-library/react) and replace removed helpers with their Testing Library equivalents.",
        );
      },
    });
  },
};

// -------------------------------------------------------------------------
// REACT-019: forwardRef no longer needed (advisory — still supported).
// -------------------------------------------------------------------------
export const ForwardRefUnneededRule: VerificationRule = {
  id: "REACT-019",
  name: "forwardRef No Longer Needed",
  description:
    "Advisory: React 19 passes ref as a regular prop, so React.forwardRef is no longer needed for components consumed only by React 19 (it still works).",
  category: "REACT_HOOKS",
  defaultSeverity: "LOW",
  check(ctx) {
    const react = importsFrom(ctx, new Set(["react"]));
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        const isMember =
          t.isMemberExpression(callee) &&
          !callee.computed &&
          t.isIdentifier(callee.object) &&
          react.namespaces.has(callee.object.name) &&
          t.isIdentifier(callee.property, { name: "forwardRef" });
        const isNamed =
          t.isIdentifier(callee) &&
          isImportBinding(path, callee.name) &&
          react.named.get(callee.name)?.imported === "forwardRef";
        if (!isMember && !isNamed) return;
        emit(
          ctx,
          path.node,
          "REACT-019",
          "LOW",
          "forwardRef is no longer needed in React 19.",
          "React 19 passes ref to function components as a regular prop, so forwardRef is only required to stay compatible with React 18 and earlier consumers. It still works — this is a modernization advisory, not a break.",
          "If you no longer support React < 19, accept ref as a normal prop and drop the forwardRef wrapper.",
        );
      },
    });
  },
};

export const REACT19_RULES: VerificationRule[] = [
  RemovedReactDomApisRule,
  CreateFactoryRule,
  StringRefRule,
  LegacyContextRule,
  FunctionDefaultPropsRule,
  PropTypesIgnoredRule,
  UseRefRequiresArgumentRule,
  UseInTryRule,
  RefCallbackReturnRule,
  TestUtilsRemovedRule,
  ForwardRefUnneededRule,
];
