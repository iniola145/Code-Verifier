import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { NullabilityValue } from "../types/verifier";

export type SummaryValue =
  | { kind: "FIXED"; nullability: NullabilityValue; taint: "CLEAN" }
  | {
      kind: "PARAMETER";
      parameterIndex: number;
      sanitized: boolean;
      fieldPath?: string[];
    };

export interface FunctionSummary {
  name: string;
  value?: SummaryValue;
  taintSinks: Array<{
    parameterIndex: number;
    kind: "ASYNC_STORAGE" | "WEBVIEW";
  }>;
}

export function buildFunctionSummaries(
  ast: t.File,
  seed: Map<string, FunctionSummary> = new Map(),
): Map<string, FunctionSummary> {
  const summaries = new Map(seed);
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    traverse(ast, {
      Function(path) {
        const name = functionName(path);
        if (!name) return;
        const expressions = returnExpressions(path);
        let value: SummaryValue | undefined;
        if (expressions) {
          const values = expressions.map((expr) =>
            summarizeExpression(expr, path.node.params, summaries),
          );
          const first = values[0];
          if (
            first &&
            values.every((candidate) => sameSummary(candidate, first))
          )
            value = first;
        }
        const taintSinks = summarizeTaintSinks(path, summaries);
        const next =
          value || taintSinks.length > 0
            ? { name, value, taintSinks }
            : undefined;
        if (
          next &&
          JSON.stringify(summaries.get(name)) !== JSON.stringify(next)
        ) {
          summaries.set(name, next);
          changed = true;
        }
      },
    });
    if (!changed) break;
  }
  return summaries;
}

function summarizeTaintSinks(
  path: any,
  summaries: Map<string, FunctionSummary>,
): FunctionSummary["taintSinks"] {
  const sinks: FunctionSummary["taintSinks"] = [];
  const params = path.node.params as t.Function["params"];
  const add = (
    expr: t.Node | null | undefined,
    kind: "ASYNC_STORAGE" | "WEBVIEW",
  ) => {
    if (!t.isIdentifier(expr)) return;
    const parameterIndex = params.findIndex((param) =>
      t.isIdentifier(param, { name: expr.name }),
    );
    if (
      parameterIndex >= 0 &&
      !sinks.some(
        (sink) => sink.parameterIndex === parameterIndex && sink.kind === kind,
      )
    ) {
      sinks.push({ parameterIndex, kind });
    }
  };
  path.traverse({
    CallExpression(callPath: any) {
      if (callPath.getFunctionParent()?.node !== path.node) return;
      const call = callPath.node as t.CallExpression;
      if (
        t.isMemberExpression(call.callee) &&
        t.isIdentifier(call.callee.object, { name: "AsyncStorage" }) &&
        t.isIdentifier(call.callee.property, { name: "setItem" })
      ) {
        const argument = call.arguments[1];
        add(t.isExpression(argument) ? argument : null, "ASYNC_STORAGE");
      }
      const name = summaryCalleeName(call.callee);
      const summary = name ? summaries.get(name) : undefined;
      if (summary) {
        for (const sink of summary.taintSinks) {
          const argument = call.arguments[sink.parameterIndex];
          add(t.isExpression(argument) ? argument : null, sink.kind);
        }
      }
    },
    JSXAttribute(attributePath: any) {
      if (attributePath.getFunctionParent()?.node !== path.node) return;
      const attribute = attributePath.node as t.JSXAttribute;
      if (
        !t.isJSXIdentifier(attribute.name) ||
        !["html", "injectedJavaScript", "source"].includes(
          attribute.name.name,
        ) ||
        !t.isJSXExpressionContainer(attribute.value)
      )
        return;
      add(
        t.isExpression(attribute.value.expression)
          ? attribute.value.expression
          : null,
        "WEBVIEW",
      );
    },
  });
  return sinks;
}

function functionName(path: any): string | null {
  const node = path.node as t.Function;
  if (t.isFunctionDeclaration(node) && node.id) return node.id.name;
  if (t.isVariableDeclarator(path.parent) && t.isIdentifier(path.parent.id))
    return path.parent.id.name;
  if (t.isExportDefaultDeclaration(path.parent)) return "default";
  return null;
}

function returnExpressions(path: any): Array<t.Expression | null> | null {
  if (!t.isBlockStatement(path.node.body)) {
    return [t.isExpression(path.node.body) ? path.node.body : null];
  }
  const returns: Array<t.Expression | null> = [];
  path.traverse({
    ReturnStatement(returnPath: any) {
      if (returnPath.getFunctionParent()?.node !== path.node) return;
      returns.push(
        t.isExpression(returnPath.node.argument)
          ? returnPath.node.argument
          : null,
      );
    },
  });
  // A reachable implicit fall-through is difficult to prove cheaply. Only
  // summarize block functions whose final statement is an explicit return.
  const last = path.node.body.body.at(-1);
  if (!last || !t.isReturnStatement(last)) return null;
  return returns;
}

function summarizeExpression(
  expr: t.Expression | null,
  params: t.Function["params"],
  summaries: Map<string, FunctionSummary>,
): SummaryValue | null {
  if (!expr || (t.isIdentifier(expr) && expr.name === "undefined")) {
    return { kind: "FIXED", nullability: "Undefined", taint: "CLEAN" };
  }
  if (t.isNullLiteral(expr))
    return { kind: "FIXED", nullability: "Null", taint: "CLEAN" };
  if (
    t.isStringLiteral(expr) ||
    t.isNumericLiteral(expr) ||
    t.isBooleanLiteral(expr) ||
    t.isObjectExpression(expr) ||
    t.isArrayExpression(expr) ||
    t.isTemplateLiteral(expr) ||
    t.isNewExpression(expr) ||
    t.isJSXElement(expr) ||
    t.isJSXFragment(expr)
  ) {
    return { kind: "FIXED", nullability: "NonNull", taint: "CLEAN" };
  }
  if (t.isIdentifier(expr)) {
    const parameterIndex = params.findIndex((param) =>
      t.isIdentifier(param, { name: expr.name }),
    );
    if (parameterIndex >= 0)
      return { kind: "PARAMETER", parameterIndex, sanitized: false };
  }
  if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
    const path: string[] = [];
    let current: t.Expression = expr;
    while (
      t.isMemberExpression(current) ||
      t.isOptionalMemberExpression(current)
    ) {
      const property =
        !current.computed && t.isIdentifier(current.property)
          ? current.property.name
          : current.computed &&
              (t.isStringLiteral(current.property) ||
                t.isNumericLiteral(current.property))
            ? String(current.property.value)
            : null;
      if (property === null) return null;
      path.unshift(property);
      current = current.object;
    }
    if (t.isIdentifier(current)) {
      const parameterIndex = params.findIndex((param) =>
        t.isIdentifier(param, { name: current.name }),
      );
      if (parameterIndex >= 0)
        return {
          kind: "PARAMETER",
          parameterIndex,
          sanitized: false,
          fieldPath: path,
        };
    }
  }
  if (t.isCallExpression(expr)) {
    const name = summaryCalleeName(expr.callee);
    const summary = name ? summaries.get(name) : undefined;
    if (summary?.value?.kind === "FIXED") return summary.value;
    if (summary?.value?.kind === "PARAMETER") {
      const argument = expr.arguments[summary.value.parameterIndex];
      if (t.isIdentifier(argument)) {
        const parameterIndex = params.findIndex((param) =>
          t.isIdentifier(param, { name: argument.name }),
        );
        if (parameterIndex >= 0) {
          return {
            kind: "PARAMETER",
            parameterIndex,
            sanitized: summary.value.sanitized,
            fieldPath: summary.value.fieldPath,
          };
        }
      } else if (
        t.isMemberExpression(argument) ||
        t.isOptionalMemberExpression(argument)
      ) {
        const argumentSummary = summarizeExpression(
          argument,
          params,
          summaries,
        );
        if (argumentSummary?.kind === "PARAMETER") {
          return {
            ...argumentSummary,
            sanitized: summary.value.sanitized,
            fieldPath: [
              ...(argumentSummary.fieldPath ?? []),
              ...(summary.value.fieldPath ?? []),
            ],
          };
        }
      }
    }
  }
  if (
    t.isCallExpression(expr) &&
    t.isMemberExpression(expr.callee) &&
    t.isIdentifier(expr.callee.object, { name: "DOMPurify" }) &&
    t.isIdentifier(expr.callee.property, { name: "sanitize" }) &&
    t.isIdentifier(expr.arguments[0])
  ) {
    const parameterIndex = params.findIndex((param) =>
      t.isIdentifier(param, { name: (expr.arguments[0] as t.Identifier).name }),
    );
    if (parameterIndex >= 0)
      return { kind: "PARAMETER", parameterIndex, sanitized: true };
  }
  return null;
}

function summaryCalleeName(callee: t.CallExpression["callee"]): string | null {
  if (t.isIdentifier(callee)) return callee.name;
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object) &&
    t.isIdentifier(callee.property)
  ) {
    return `${callee.object.name}.${callee.property.name}`;
  }
  return null;
}

function sameSummary(a: SummaryValue | null, b: SummaryValue): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "FIXED" && b.kind === "FIXED") {
    return a.nullability === b.nullability && a.taint === b.taint;
  }
  return (
    a.kind === "PARAMETER" &&
    b.kind === "PARAMETER" &&
    a.parameterIndex === b.parameterIndex &&
    a.sanitized === b.sanitized &&
    JSON.stringify(a.fieldPath ?? []) === JSON.stringify(b.fieldPath ?? [])
  );
}
