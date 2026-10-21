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
  category: "CORRECTNESS" | "REACT_HOOKS" = "CORRECTNESS",
  severity: "HIGH" | "MEDIUM" = "HIGH",
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    category,
    severity,
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

function stateTypeIsNullish(
  params: t.TSTypeParameterInstantiation | t.TypeParameterInstantiation,
): boolean {
  if (!t.isTSTypeParameterInstantiation(params)) return false;
  const stateType = params.params[0];
  if (!stateType) return false;
  const unwrapped = t.isTSParenthesizedType(stateType)
    ? stateType.typeAnnotation
    : stateType;
  if (t.isTSNullKeyword(unwrapped) || t.isTSUndefinedKeyword(unwrapped))
    return true;
  return (
    t.isTSUnionType(unwrapped) &&
    unwrapped.types.some(
      (member) => t.isTSNullKeyword(member) || t.isTSUndefinedKeyword(member),
    )
  );
}

function identifierCanBeNullish(path: NodePath<t.Identifier>): boolean {
  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return false;
  const bindingPath = binding.path;
  if (
    bindingPath.isVariableDeclarator() &&
    t.isArrayPattern(bindingPath.node.id)
  ) {
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
      (t.isIdentifier(test, { name }) &&
        parent.get("consequent").isAncestor(path)) ||
      (t.isBinaryExpression(test) &&
        ["!=", "!=="].includes(test.operator) &&
        t.isIdentifier(test.left, { name }) &&
        (t.isNullLiteral(test.right) ||
          t.isIdentifier(test.right, { name: "undefined" })) &&
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
    const exits =
      t.isReturnStatement(consequent) ||
      (t.isBlockStatement(consequent) &&
        consequent.body.some(
          (s) => t.isReturnStatement(s) || t.isThrowStatement(s),
        ));
    if (!exits || !t.isBinaryExpression(test)) continue;
    if (
      ["==", "==="].includes(test.operator) &&
      t.isIdentifier(test.left, { name }) &&
      (t.isNullLiteral(test.right) ||
        t.isIdentifier(test.right, { name: "undefined" }))
    )
      return true;
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

function resolvesToNumericLiteral(path: NodePath<t.Expression>): number | null {
  if (path.isNumericLiteral()) return path.node.value;
  if (!path.isIdentifier()) return null;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding?.constant || !binding.path.isVariableDeclarator()) return null;
  const init = binding.path.get("init");
  return init.isNumericLiteral() ? init.node.value : null;
}

export const DefiniteZeroDivisionRule: VerificationRule = {
  id: "LOGIC-005",
  name: "Definite Division by Zero",
  description:
    "Detects division or remainder operations whose divisor is provably zero.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      BinaryExpression(path) {
        if (!["/", "%"].includes(path.node.operator)) return;
        const right = path.get("right");
        if (!right.isExpression() || resolvesToNumericLiteral(right) !== 0)
          return;
        emit(
          ctx,
          right.node,
          "LOGIC-005",
          `The '${path.node.operator}' operation has a divisor of zero.`,
          path.node.operator === "/"
            ? "JavaScript returns Infinity or -Infinity instead of throwing, allowing an invalid number to spread through later calculations."
            : "Remainder by zero evaluates to NaN and contaminates subsequent calculations.",
          "Ensure the divisor is non-zero before performing the operation.",
        );
      },
    });
  },
};

function isUncheckedNumericParse(node: t.Node): boolean {
  if (!t.isCallExpression(node)) return false;
  const callee = node.callee;
  return (
    (t.isIdentifier(callee) &&
      ["parseInt", "parseFloat", "Number"].includes(callee.name)) ||
    (t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object, { name: "Number" }) &&
      t.isIdentifier(callee.property) &&
      ["parseInt", "parseFloat"].includes(callee.property.name))
  );
}

export const UncheckedNumericParseRule: VerificationRule = {
  id: "LOGIC-006",
  name: "Unchecked Numeric Parse",
  description:
    "Detects numeric parsing used directly in arithmetic without a NaN fallback.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      BinaryExpression(path) {
        if (!["+", "-", "*", "/", "%", "**"].includes(path.node.operator))
          return;
        for (const operand of [path.node.left, path.node.right]) {
          if (!isUncheckedNumericParse(operand)) continue;
          emit(
            ctx,
            operand,
            "LOGIC-006",
            "A parsed number is used in arithmetic without validating NaN.",
            "Numeric parsing can return NaN for empty, malformed, or partially validated input, and NaN silently propagates through calculations.",
            "Validate the parsed result with Number.isFinite/Number.isNaN, or provide an explicit fallback before arithmetic.",
          );
        }
      },
    });
  },
};

export const InvalidNaNComparisonRule: VerificationRule = {
  id: "LOGIC-007",
  name: "Invalid NaN Comparison",
  description:
    "Detects equality comparisons with NaN, which can never succeed.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      BinaryExpression(path) {
        if (!["==", "===", "!=", "!=="].includes(path.node.operator)) return;
        const hasNaN =
          t.isIdentifier(path.node.left, { name: "NaN" }) ||
          t.isIdentifier(path.node.right, { name: "NaN" });
        if (!hasNaN) return;
        emit(
          ctx,
          path.node,
          "LOGIC-007",
          "NaN is compared using an equality operator.",
          "NaN is unequal to every value, including itself, so this comparison is constant and cannot validate numeric input.",
          "Use Number.isNaN(value), or Number.isFinite(value) when infinities are also invalid.",
        );
      },
    });
  },
};

function isNullableStateWithNonNullInitial(
  path: NodePath<t.Identifier>,
): boolean {
  const binding = path.scope.getBinding(path.node.name);
  if (
    !binding?.path.isVariableDeclarator() ||
    !t.isArrayPattern(binding.path.node.id)
  )
    return false;
  const init = binding.path.node.init;
  if (!t.isCallExpression(init)) return false;
  const callee = init.callee;
  const isUseState =
    t.isIdentifier(callee, { name: "useState" }) ||
    (t.isMemberExpression(callee) &&
      t.isIdentifier(callee.property, { name: "useState" }));
  const params = init.typeParameters ?? init.typeArguments;
  const initial = init.arguments[0];
  return !!(
    isUseState &&
    params &&
    stateTypeIsNullish(params) &&
    initial &&
    !t.isNullLiteral(initial) &&
    !t.isIdentifier(initial, { name: "undefined" })
  );
}

export const NullableStateLifecycleRule: VerificationRule = {
  id: "REACT-021",
  name: "Nullable State Lifecycle Dereference",
  description:
    "Detects state declared nullable but dereferenced as if its non-null initial value persisted across renders.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      MemberExpression(path) {
        if (path.node.optional || !t.isIdentifier(path.node.object)) return;
        const object = path.get("object");
        if (!object.isIdentifier()) return;
        if (
          !isNullableStateWithNonNullInitial(object) ||
          isNullishGuarded(object)
        )
          return;
        emit(
          ctx,
          path.node,
          "REACT-021",
          `Nullable state '${object.node.name}' is dereferenced without a render-time guard.`,
          "A later state update can replace the non-null initial value with null or undefined on a subsequent render.",
          `Guard '${object.node.name}' in the render that uses it, use optional chaining, or make the state type non-nullable.`,
          "REACT_HOOKS",
          "MEDIUM",
        );
      },
    });
  },
};

function isMethodCall(node: t.Node, name: string): node is t.CallExpression {
  return (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.property, { name })
  );
}

export const UnsafeFindResultRule: VerificationRule = {
  id: "LOGIC-008",
  name: "Unsafe Array Find Result",
  description:
    "Detects immediate property access on Array.find results that may be undefined.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      MemberExpression(path) {
        if (path.node.optional || !isMethodCall(path.node.object, "find"))
          return;
        emit(
          ctx,
          path.node,
          "LOGIC-008",
          "A property is read directly from an Array.find result.",
          "Array.find returns undefined when no element matches, so the property access can fail on valid empty or unmatched input.",
          "Store and guard the result, use optional chaining, or provide an explicit fallback.",
        );
      },
    });
  },
};

export const UnsafeArrayRemovalResultRule: VerificationRule = {
  id: "LOGIC-009",
  name: "Unsafe Array Removal Result",
  description:
    "Detects immediate dereference of pop/shift results that may be undefined.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      MemberExpression(path) {
        if (path.node.optional || !t.isCallExpression(path.node.object)) return;
        const callee = path.node.object.callee;
        if (
          !t.isMemberExpression(callee) ||
          !t.isIdentifier(callee.property) ||
          !["pop", "shift"].includes(callee.property.name)
        )
          return;
        emit(
          ctx,
          path.node,
          "LOGIC-009",
          `A property is read directly from Array.${callee.property.name}().`,
          `Array.${callee.property.name} returns undefined for an empty array, so this dereference can fail.`,
          "Guard the removed value or use optional chaining before accessing its properties.",
        );
      },
    });
  },
};

export const EmptyReduceRule: VerificationRule = {
  id: "LOGIC-010",
  name: "Reduce Without Initial Value",
  description:
    "Detects reduce calls that can throw when the input array is empty.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (
          !isMethodCall(path.node, "reduce") ||
          path.node.arguments.length !== 1
        )
          return;
        const callee = path.node.callee;
        if (!t.isMemberExpression(callee)) return;
        const receiver = callee.object;
        if (t.isArrayExpression(receiver) && receiver.elements.length > 0)
          return;
        emit(
          ctx,
          path.node,
          "LOGIC-010",
          "reduce() has no initial value on an array that may be empty.",
          "Calling reduce without an initial accumulator throws TypeError for an empty array, turning valid empty input into a runtime failure.",
          "Pass an explicit initial accumulator or prove the collection is non-empty before reducing.",
          "CORRECTNESS",
          "MEDIUM",
        );
      },
    });
  },
};

export const AccidentalSwitchFallthroughRule: VerificationRule = {
  id: "LOGIC-011",
  name: "Unmarked Switch Fallthrough",
  description:
    "Detects non-empty switch cases that fall through without an explicit marker.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      SwitchStatement(path) {
        const cases = path.node.cases;
        for (let index = 0; index < cases.length - 1; index++) {
          const current = cases[index];
          if (current.consequent.length === 0) continue;
          const last = current.consequent[current.consequent.length - 1];
          if (
            t.isBreakStatement(last) ||
            t.isReturnStatement(last) ||
            t.isThrowStatement(last) ||
            t.isContinueStatement(last)
          )
            continue;
          const comments = [
            ...(current.trailingComments ?? []),
            ...(last.trailingComments ?? []),
            ...(cases[index + 1].leadingComments ?? []),
          ];
          if (
            comments.some((comment) => /fall\s*-?through/i.test(comment.value))
          )
            continue;
          emit(
            ctx,
            current,
            "LOGIC-011",
            "A non-empty switch case falls through to the next case.",
            "Missing break/return commonly executes another case's logic and corrupts state while still appearing syntactically valid.",
            "Add break, return, or throw; if fallthrough is intentional, document it with a fallthrough comment.",
            "CORRECTNESS",
            "MEDIUM",
          );
        }
      },
    });
  },
};

function isHookCall(node: t.CallExpression, name: string): boolean {
  return (
    t.isIdentifier(node.callee, { name }) ||
    (t.isMemberExpression(node.callee) &&
      t.isIdentifier(node.callee.property, { name }))
  );
}

export const EffectRequestRaceRule: VerificationRule = {
  id: "REACT-022",
  name: "Uncancelled Effect Request",
  description:
    "Detects dependency-driven effects that fetch and update state without cleanup.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (!isHookCall(path.node, "useEffect")) return;
        const callback = path.get("arguments.0");
        const deps = path.node.arguments[1];
        if (
          (!callback.isArrowFunctionExpression() &&
            !callback.isFunctionExpression()) ||
          !t.isBlockStatement(callback.node.body) ||
          !t.isArrayExpression(deps) ||
          deps.elements.length === 0
        )
          return;
        let hasFetch = false;
        let hasSetter = false;
        let hasCleanup = false;
        callback.traverse({
          CallExpression(inner) {
            if (t.isIdentifier(inner.node.callee, { name: "fetch" }))
              hasFetch = true;
            if (
              t.isIdentifier(inner.node.callee) &&
              /^set[A-Z]/.test(inner.node.callee.name)
            )
              hasSetter = true;
          },
          ReturnStatement(inner) {
            if (
              t.isFunctionExpression(inner.node.argument) ||
              t.isArrowFunctionExpression(inner.node.argument)
            )
              hasCleanup = true;
          },
          Identifier(inner) {
            if (
              /^set[A-Z]/.test(inner.node.name) &&
              inner.isReferencedIdentifier()
            )
              hasSetter = true;
          },
        });
        if (!hasFetch || !hasSetter || hasCleanup) return;
        emit(
          ctx,
          path.node,
          "REACT-022",
          "An effect fetches data and updates state without cancellation cleanup.",
          "When dependencies change, an older request can resolve last and overwrite newer state; it can also update after unmount.",
          "Use AbortController or an ignore flag and return cleanup that invalidates the previous request.",
          "REACT_HOOKS",
          "MEDIUM",
        );
      },
    });
  },
};

export const EffectTimerStateUpdateRule: VerificationRule = {
  id: "REACT-023",
  name: "Uncancelled Delayed State Update",
  description:
    "Detects effect timeouts that update state without clearing the timeout.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (!isHookCall(path.node, "useEffect")) return;
        const callback = path.get("arguments.0");
        if (
          (!callback.isArrowFunctionExpression() &&
            !callback.isFunctionExpression()) ||
          !t.isBlockStatement(callback.node.body)
        )
          return;
        let riskyTimer: t.CallExpression | null = null;
        let clearsTimer = false;
        callback.traverse({
          CallExpression(inner) {
            if (t.isIdentifier(inner.node.callee, { name: "clearTimeout" }))
              clearsTimer = true;
            if (!t.isIdentifier(inner.node.callee, { name: "setTimeout" }))
              return;
            const timerCallback = inner.get("arguments.0");
            if (
              !timerCallback.isFunctionExpression() &&
              !timerCallback.isArrowFunctionExpression()
            )
              return;
            let updatesState = false;
            timerCallback.traverse({
              CallExpression(call) {
                if (
                  t.isIdentifier(call.node.callee) &&
                  /^set[A-Z]/.test(call.node.callee.name)
                )
                  updatesState = true;
              },
            });
            if (updatesState) riskyTimer = inner.node;
          },
        });
        if (!riskyTimer || clearsTimer) return;
        emit(
          ctx,
          riskyTimer,
          "REACT-023",
          "An effect schedules a delayed state update without clearing its timeout.",
          "The timeout can fire after unmount or after dependencies change, applying stale state to the wrong lifecycle instance.",
          "Store the timeout handle and return cleanup that calls clearTimeout(handle).",
          "REACT_HOOKS",
          "MEDIUM",
        );
      },
    });
  },
};

export const StaleAsyncStateUpdateRule: VerificationRule = {
  id: "REACT-024",
  name: "Stale Async State Update",
  description:
    "Detects delayed state updates computed from a captured render value.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    const setters = new Map<string, string>();
    traverse(ctx.ast, {
      VariableDeclarator(path) {
        if (
          !t.isArrayPattern(path.node.id) ||
          !t.isCallExpression(path.node.init) ||
          !isHookCall(path.node.init, "useState")
        )
          return;
        const [state, setter] = path.node.id.elements;
        if (t.isIdentifier(state) && t.isIdentifier(setter))
          setters.set(setter.name, state.name);
      },
    });
    traverse(ctx.ast, {
      CallExpression(path) {
        if (!t.isIdentifier(path.node.callee)) return;
        const stateName = setters.get(path.node.callee.name);
        const argument = path.node.arguments[0];
        if (!stateName || !t.isExpression(argument) || t.isFunction(argument))
          return;
        let readsState = false;
        path.get("arguments.0").traverse({
          Identifier(id) {
            if (id.node.name === stateName && id.isReferencedIdentifier())
              readsState = true;
          },
        });
        if (!readsState) return;
        const delayed = path.findParent(
          (parent) =>
            (parent.isFunction() && parent.node.async) ||
            (parent.isCallExpression() &&
              t.isIdentifier(parent.node.callee, { name: "setTimeout" })),
        );
        if (!delayed) return;
        emit(
          ctx,
          path.node,
          "REACT-024",
          `State setter '${path.node.callee.name}' uses captured '${stateName}' in delayed work.`,
          "Multiple delayed updates can all read the same old render value, losing increments or overwriting newer state.",
          `Use the functional form ${path.node.callee.name}(current => ...) so React supplies the latest state.`,
          "REACT_HOOKS",
          "MEDIUM",
        );
      },
    });
  },
};

export const UncheckedFetchResponseRule: VerificationRule = {
  id: "SERVICE-001",
  name: "Unchecked Fetch Response",
  description:
    "Detects fetch responses consumed as JSON without checking HTTP success.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      VariableDeclarator(path) {
        if (
          !t.isIdentifier(path.node.id) ||
          !t.isAwaitExpression(path.node.init) ||
          !t.isCallExpression(path.node.init.argument) ||
          !t.isIdentifier(path.node.init.argument.callee, { name: "fetch" })
        )
          return;
        const name = path.node.id.name;
        const scope = path.getFunctionParent() ?? path.scope.path;
        let consumesBody = false;
        let checksStatus = false;
        scope.traverse({
          MemberExpression(member) {
            if (
              !t.isIdentifier(member.node.object, { name }) ||
              !t.isIdentifier(member.node.property)
            )
              return;
            if (
              ["ok", "status", "statusText"].includes(member.node.property.name)
            )
              checksStatus = true;
            if (
              ["json", "text", "blob", "arrayBuffer", "formData"].includes(
                member.node.property.name,
              ) &&
              member.parentPath.isCallExpression()
            )
              consumesBody = true;
          },
        });
        if (!consumesBody || checksStatus) return;
        emit(
          ctx,
          path.node,
          "SERVICE-001",
          `Fetch response '${name}' is consumed without checking HTTP status.`,
          "fetch resolves normally for HTTP 4xx/5xx responses, so error payloads can be accepted as successful domain data.",
          `Check '${name}.ok' or '${name}.status' before parsing and returning the response body.`,
          "CORRECTNESS",
          "MEDIUM",
        );
      },
    });
  },
};

export const LeakedRequestTimeoutRule: VerificationRule = {
  id: "SERVICE-002",
  name: "Leaked Request Timeout",
  description:
    "Detects abort timeouts around fetch requests that are never cleared.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      Function(path) {
        let timeout: t.CallExpression | null = null;
        let hasFetch = false;
        let clearsTimeout = false;
        path.traverse({
          Function(inner) {
            if (inner !== path) inner.skip();
          },
          CallExpression(call) {
            if (t.isIdentifier(call.node.callee, { name: "fetch" }))
              hasFetch = true;
            if (t.isIdentifier(call.node.callee, { name: "clearTimeout" }))
              clearsTimeout = true;
            if (!t.isIdentifier(call.node.callee, { name: "setTimeout" }))
              return;
            const callback = call.get("arguments.0");
            if (
              !callback.isArrowFunctionExpression() &&
              !callback.isFunctionExpression()
            )
              return;
            let aborts = false;
            callback.traverse({
              CallExpression(inner) {
                if (
                  t.isMemberExpression(inner.node.callee) &&
                  t.isIdentifier(inner.node.callee.property, { name: "abort" })
                )
                  aborts = true;
              },
            });
            if (aborts) timeout = call.node;
          },
        });
        if (!timeout || !hasFetch || clearsTimeout) return;
        emit(
          ctx,
          timeout,
          "SERVICE-002",
          "A request abort timeout is never cleared.",
          "The timer remains live after an early success or failure and can retain closures, fire needlessly, and interfere with reused cancellation state.",
          "Store the timeout handle and clear it in a finally block covering the fetch operation.",
          "CORRECTNESS",
          "MEDIUM",
        );
      },
    });
  },
};

export const LOGIC_ANALYSIS_RULES: VerificationRule[] = [
  NullableArithmeticRule,
  DefiniteZeroDivisionRule,
  UncheckedNumericParseRule,
  InvalidNaNComparisonRule,
  NullableStateLifecycleRule,
  UnsafeFindResultRule,
  UnsafeArrayRemovalResultRule,
  EmptyReduceRule,
  AccidentalSwitchFallthroughRule,
  EffectRequestRaceRule,
  EffectTimerStateUpdateRule,
  StaleAsyncStateUpdateRule,
  UncheckedFetchResponseRule,
  LeakedRequestTimeoutRule,
];
