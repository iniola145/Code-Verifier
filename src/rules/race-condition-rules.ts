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

function memberName(node: t.Node | null | undefined): string | null {
  if (
    !t.isMemberExpression(node) ||
    node.computed ||
    !t.isIdentifier(node.property)
  )
    return null;
  return node.property.name;
}

function isRequestCall(node: t.Node): node is t.CallExpression {
  if (!t.isCallExpression(node)) return false;
  if (t.isIdentifier(node.callee, { name: "fetch" })) return true;
  const name = memberName(node.callee);
  return (
    !!name &&
    [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "request",
      "query",
      "mutate",
      "search",
    ].includes(name)
  );
}

function functionScope(path: NodePath): NodePath | null {
  return path.isFunction() ? path : path.getFunctionParent();
}

export const DisconnectedAbortControllerRule: VerificationRule = {
  id: "RACE-001",
  name: "Disconnected Abort Controller",
  description:
    "Detects controllers that are aborted but whose signal is not passed to the request.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      VariableDeclarator(path) {
        if (
          !t.isIdentifier(path.node.id) ||
          !t.isNewExpression(path.node.init) ||
          !t.isIdentifier(path.node.init.callee, { name: "AbortController" })
        )
          return;
        const controller = path.node.id.name;
        const scope = functionScope(path);
        if (!scope) return;
        let aborts = false;
        let request: t.CallExpression | null = null;
        let connected = false;
        scope.traverse({
          CallExpression(call) {
            if (
              t.isMemberExpression(call.node.callee) &&
              t.isIdentifier(call.node.callee.object, { name: controller }) &&
              t.isIdentifier(call.node.callee.property, { name: "abort" })
            )
              aborts = true;
            if (!isRequestCall(call.node)) return;
            request = call.node;
            for (const argument of call.node.arguments) {
              if (!t.isObjectExpression(argument)) continue;
              for (const property of argument.properties) {
                if (
                  !t.isObjectProperty(property) ||
                  !t.isIdentifier(property.key, { name: "signal" })
                )
                  continue;
                if (
                  t.isMemberExpression(property.value) &&
                  t.isIdentifier(property.value.object, { name: controller }) &&
                  t.isIdentifier(property.value.property, { name: "signal" })
                )
                  connected = true;
              }
            }
          },
        });
        if (!aborts || !request || connected) return;
        emit(
          ctx,
          request,
          "RACE-001",
          `AbortController '${controller}' is not connected to the request.`,
          "Cleanup calls abort(), but the request never receives the controller signal, so stale responses can still win the race.",
          `Pass { signal: ${controller}.signal } through the request client and ensure wrappers forward it to fetch.`,
        );
      },
    });
  },
};

export const LatestRequestWinsRule: VerificationRule = {
  id: "RACE-002",
  name: "Unprotected Latest-Request Update",
  description:
    "Detects parameterized async requests that commit results without cancellation or sequence ownership.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      Function(path) {
        if (!path.node.async || path.node.params.length === 0) return;
        const params = new Set<string>();
        for (const parameter of path.node.params) {
          if (t.isIdentifier(parameter)) params.add(parameter.name);
        }
        if (params.size === 0) return;
        let request: t.CallExpression | null = null;
        let requestUsesParam = false;
        let setterAfterAwait: t.CallExpression | null = null;
        let awaitEnd = Infinity;
        let protectedRequest = false;
        path.traverse({
          AwaitExpression(inner) {
            if (!isRequestCall(inner.node.argument)) return;
            request = inner.node.argument;
            awaitEnd = inner.node.end ?? awaitEnd;
            inner.get("argument").traverse({
              Identifier(id) {
                if (params.has(id.node.name)) requestUsesParam = true;
              },
            });
          },
          CallExpression(inner) {
            if (
              t.isIdentifier(inner.node.callee) &&
              /^set[A-Z]/.test(inner.node.callee.name) &&
              (inner.node.start ?? 0) > awaitEnd
            )
              setterAfterAwait = inner.node;
            if (
              t.isMemberExpression(inner.node.callee) &&
              t.isIdentifier(inner.node.callee.property) &&
              ["abort", "isCurrent", "isLatest"].includes(
                inner.node.callee.property.name,
              )
            )
              protectedRequest = true;
          },
          BinaryExpression(inner) {
            if (
              ["===", "!=="].includes(inner.node.operator) &&
              (t.isMemberExpression(inner.node.left) ||
                t.isMemberExpression(inner.node.right))
            )
              protectedRequest = true;
          },
        });
        if (
          !request ||
          !requestUsesParam ||
          !setterAfterAwait ||
          protectedRequest
        )
          return;
        emit(
          ctx,
          setterAfterAwait,
          "RACE-002",
          "A parameterized request commits state without proving it is still the latest request.",
          "Rapid user input can start overlapping requests; an older response may finish last and overwrite the newer result.",
          "Abort the previous request or compare a monotonically increasing request id before committing state.",
        );
      },
    });
  },
};

export const StorageReadModifyWriteRule: VerificationRule = {
  id: "RACE-003",
  name: "Non-Atomic Storage Update",
  description:
    "Detects frontend storage read-modify-write sequences that can lose concurrent updates.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      Function(path) {
        const reads = new Map<string, { variable: string; node: t.Node }>();
        path.traverse({
          VariableDeclarator(inner) {
            if (
              !t.isIdentifier(inner.node.id) ||
              !t.isAwaitExpression(inner.node.init) ||
              !t.isCallExpression(inner.node.init.argument)
            )
              return;
            const call = inner.node.init.argument;
            if (
              memberName(call.callee) !== "getItem" ||
              !t.isStringLiteral(call.arguments[0])
            )
              return;
            reads.set(call.arguments[0].value, {
              variable: inner.node.id.name,
              node: call,
            });
          },
          CallExpression(inner) {
            if (
              memberName(inner.node.callee) !== "setItem" ||
              !t.isStringLiteral(inner.node.arguments[0])
            )
              return;
            const read = reads.get(inner.node.arguments[0].value);
            if (!read) return;
            const value = inner.get("arguments.1");
            let usesPrior = false;
            if (value?.node)
              value.traverse({
                Identifier(id) {
                  if (id.node.name === read.variable) usesPrior = true;
                },
              });
            if (!usesPrior) return;
            emit(
              ctx,
              inner.node,
              "RACE-003",
              `Storage key '${inner.node.arguments[0].value}' is updated with a read-modify-write sequence.`,
              "Two callbacks can read the same old value and overwrite each other, losing one frontend update.",
              "Serialize updates through one store/queue, or use a backend atomic mutation when the value is shared across clients.",
            );
          },
        });
      },
    });
  },
};

export const OverlappingLoadingStateRule: VerificationRule = {
  id: "RACE-004",
  name: "Shared Boolean Loading Race",
  description:
    "Detects async request functions whose shared boolean loading flag can be cleared by an older request.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      Function(path) {
        if (!path.node.async) return;
        const calls = new Map<string, boolean[]>();
        let hasRequestAwait = false;
        path.traverse({
          AwaitExpression(inner) {
            if (isRequestCall(inner.node.argument)) hasRequestAwait = true;
          },
          CallExpression(inner) {
            if (
              !t.isIdentifier(inner.node.callee) ||
              !/^set[A-Z]/.test(inner.node.callee.name)
            )
              return;
            const arg = inner.node.arguments[0];
            if (!t.isBooleanLiteral(arg)) return;
            const values = calls.get(inner.node.callee.name) ?? [];
            values.push(arg.value);
            calls.set(inner.node.callee.name, values);
          },
        });
        if (!hasRequestAwait) return;
        for (const [setter, values] of calls) {
          if (!values.includes(true) || !values.includes(false)) continue;
          const bodyText = path.toString();
          const stateName = setter
            .replace(/^set/, "")
            .replace(/^./, (c) => c.toLowerCase());
          if (new RegExp(`if\\s*\\(\\s*${stateName}\\s*\\)`).test(bodyText))
            continue;
          emit(
            ctx,
            path.node,
            "RACE-004",
            `Shared loading flag '${stateName}' is toggled around a request that may overlap.`,
            "An older request can finish first and clear the boolean while a newer request is still active.",
            "Use a request counter/id, cancel the previous request, or prevent overlapping invocation synchronously.",
          );
        }
      },
    });
  },
};

export const SubscriptionCleanupRule: VerificationRule = {
  id: "RACE-005",
  name: "Subscription Without Cleanup",
  description:
    "Detects effects that create subscriptions without returning teardown.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (!t.isIdentifier(path.node.callee, { name: "useEffect" })) return;
        const callback = path.get("arguments.0");
        if (!callback.isFunction() || !t.isBlockStatement(callback.node.body))
          return;
        let subscription: t.CallExpression | null = null;
        let cleanup = false;
        callback.traverse({
          CallExpression(inner) {
            const name = memberName(inner.node.callee);
            if (["subscribe", "addListener", "on"].includes(name ?? ""))
              subscription = inner.node;
            if (
              ["unsubscribe", "remove", "removeListener", "off"].includes(
                name ?? "",
              )
            )
              cleanup = true;
          },
          ReturnStatement(inner) {
            if (t.isFunction(inner.node.argument)) cleanup = true;
          },
        });
        if (!subscription || cleanup) return;
        emit(
          ctx,
          subscription,
          "RACE-005",
          "An effect creates a subscription without teardown.",
          "Old component instances keep receiving events after dependency changes or unmount, causing duplicate and stale updates.",
          "Return cleanup that unsubscribes or removes the exact listener registered by this effect.",
        );
      },
    });
  },
};

export const PromiseRaceWithoutAbortRule: VerificationRule = {
  id: "RACE-006",
  name: "Promise Timeout Without Cancellation",
  description:
    "Detects Promise.race request timeouts that leave the losing request running.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (
          !t.isMemberExpression(path.node.callee) ||
          !t.isIdentifier(path.node.callee.object, { name: "Promise" }) ||
          !t.isIdentifier(path.node.callee.property, { name: "race" })
        )
          return;
        const arg = path.node.arguments[0];
        if (!t.isArrayExpression(arg)) return;
        const hasRequest = arg.elements.some(
          (element) => !!element && isRequestCall(element),
        );
        const hasTimer = arg.elements.some((element) => {
          if (!element) return false;
          let found = false;
          const inspect = (node: t.Node): void => {
            if (
              t.isCallExpression(node) &&
              t.isIdentifier(node.callee, { name: "setTimeout" })
            )
              found = true;
            for (const value of Object.values(node)) {
              if (value && typeof value === "object" && "type" in value)
                inspect(value as t.Node);
              if (Array.isArray(value))
                for (const item of value)
                  if (item && typeof item === "object" && "type" in item)
                    inspect(item as t.Node);
            }
          };
          inspect(element);
          return found;
        });
        const scope = functionScope(path);
        if (
          !hasRequest ||
          !hasTimer ||
          (scope && /AbortController/.test(scope.toString()))
        )
          return;
        emit(
          ctx,
          path.node,
          "RACE-006",
          "Promise.race times out a request without cancelling the losing operation.",
          "Promise.race only ignores the later result; the network request continues and can still perform side effects or consume resources.",
          "Use AbortController and abort the request when the timeout wins.",
        );
      },
    });
  },
};

export const StaleOptimisticRollbackRule: VerificationRule = {
  id: "RACE-007",
  name: "Stale Optimistic Rollback",
  description:
    "Detects unconditional optimistic rollback that can overwrite a newer successful mutation.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      Function(path) {
        if (!path.node.async) return;
        const snapshots = new Set<string>();
        let requestEnd = -1;
        let optimisticSetter: string | null = null;
        path.traverse({
          VariableDeclarator(inner) {
            if (
              t.isIdentifier(inner.node.id) &&
              (t.isIdentifier(inner.node.init) ||
                t.isMemberExpression(inner.node.init) ||
                t.isArrayExpression(inner.node.init) ||
                t.isObjectExpression(inner.node.init))
            )
              snapshots.add(inner.node.id.name);
          },
          CallExpression(inner) {
            if (
              t.isIdentifier(inner.node.callee) &&
              /^set[A-Z]/.test(inner.node.callee.name) &&
              requestEnd < 0
            )
              optimisticSetter = inner.node.callee.name;
          },
          AwaitExpression(inner) {
            if (isRequestCall(inner.node.argument))
              requestEnd = inner.node.end ?? requestEnd;
          },
          CatchClause(inner) {
            if (requestEnd < 0 || !optimisticSetter) return;
            inner.traverse({
              CallExpression(call) {
                if (
                  !t.isIdentifier(call.node.callee, { name: optimisticSetter! })
                )
                  return;
                const argument = call.get("arguments.0");
                let restoresSnapshot =
                  argument.isIdentifier() && snapshots.has(argument.node.name);
                argument.traverse({
                  Identifier(id) {
                    if (snapshots.has(id.node.name)) restoresSnapshot = true;
                  },
                });
                if (!restoresSnapshot) return;
                emit(
                  ctx,
                  call.node,
                  "RACE-007",
                  "An optimistic mutation unconditionally restores an old snapshot on failure.",
                  "If another mutation succeeds before this request fails, the older rollback can erase the newer committed UI state.",
                  "Tag optimistic mutations with request/version ids and only roll back fields still owned by the failed mutation.",
                );
              },
            });
          },
        });
      },
    });
  },
};

export const RenderLocalDebounceRule: VerificationRule = {
  id: "RACE-008",
  name: "Render-Local Debounce Handle",
  description:
    "Detects timer handles recreated on each component render and captured by callbacks.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      Function(path) {
        let hasHook = false;
        const locals = new Map<string, t.VariableDeclarator>();
        path.traverse({
          Function(inner) {
            if (inner !== path && !inner.isArrowFunctionExpression())
              inner.skip();
          },
          CallExpression(inner) {
            if (
              t.isIdentifier(inner.node.callee) &&
              /^use[A-Z]/.test(inner.node.callee.name)
            )
              hasHook = true;
          },
          VariableDeclarator(inner) {
            if (
              inner.getFunctionParent() !== path ||
              !t.isIdentifier(inner.node.id)
            )
              return;
            if (
              !inner.node.init ||
              t.isNullLiteral(inner.node.init) ||
              t.isIdentifier(inner.node.init, { name: "undefined" })
            )
              locals.set(inner.node.id.name, inner.node);
          },
        });
        if (!hasHook) return;
        for (const [name, declaration] of locals) {
          let clears = false;
          let assignsTimer = false;
          path.traverse({
            CallExpression(inner) {
              if (
                t.isIdentifier(inner.node.callee, { name: "clearTimeout" }) &&
                t.isIdentifier(inner.node.arguments[0], { name })
              )
                clears = true;
            },
            AssignmentExpression(inner) {
              if (
                t.isIdentifier(inner.node.left, { name }) &&
                t.isCallExpression(inner.node.right) &&
                t.isIdentifier(inner.node.right.callee, { name: "setTimeout" })
              )
                assignsTimer = true;
            },
          });
          if (!clears || !assignsTimer) continue;
          emit(
            ctx,
            declaration,
            "RACE-008",
            `Timer handle '${name}' is recreated on every render.`,
            "Callbacks from different renders capture different handles, so cleanup may miss an older timer and allow stale work to fire.",
            `Store '${name}' in useRef and clear ref.current before scheduling and during unmount cleanup.`,
          );
        }
      },
    });
  },
};

export const RACE_CONDITION_RULES: VerificationRule[] = [
  DisconnectedAbortControllerRule,
  LatestRequestWinsRule,
  StorageReadModifyWriteRule,
  OverlappingLoadingStateRule,
  SubscriptionCleanupRule,
  PromiseRaceWithoutAbortRule,
  StaleOptimisticRollbackRule,
  RenderLocalDebounceRule,
];
