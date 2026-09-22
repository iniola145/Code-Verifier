import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";

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
    category: ruleId.startsWith("RN-") ? "REACT_NATIVE_EXPO" : "REACT_HOOKS",
    severity,
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

function jsxAttribute(
  element: t.JSXOpeningElement,
  name: string,
): t.JSXAttribute | null {
  return (
    element.attributes.find(
      (attribute): attribute is t.JSXAttribute =>
        t.isJSXAttribute(attribute) &&
        t.isJSXIdentifier(attribute.name, { name }),
    ) ?? null
  );
}

export const AsyncEffectRule: VerificationRule = {
  id: "REACT-004",
  name: "Async Effect Setup Function",
  description:
    "Detects async functions passed directly to useEffect or useLayoutEffect.",
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
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
          (!t.isArrowFunctionExpression(setup) &&
            !t.isFunctionExpression(setup)) ||
          !setup.async
        )
          return;
        emit(
          ctx,
          path.node,
          "REACT-004",
          "HIGH",
          "An Effect setup function is declared async.",
          "An async function returns a Promise, but React expects the Effect return value to be undefined or a synchronous cleanup function.",
          "Define and call an inner async function, and return a synchronous cleanup function from the Effect.",
        );
      },
    });
  },
};

export const ArrayIndexKeyRule: VerificationRule = {
  id: "REACT-005",
  name: "Array Index Used as React Key",
  description: "Detects map callback indexes used as JSX keys.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      JSXAttribute(path) {
        if (
          !t.isJSXIdentifier(path.node.name, { name: "key" }) ||
          !t.isJSXExpressionContainer(path.node.value) ||
          !t.isIdentifier(path.node.value.expression)
        )
          return;
        const callback = path.findParent(
          (candidate) =>
            candidate.isArrowFunctionExpression() ||
            candidate.isFunctionExpression(),
        );
        if (
          !callback ||
          (!callback.isArrowFunctionExpression() &&
            !callback.isFunctionExpression())
        )
          return;
        const indexParam = callback.node.params[1];
        if (
          !t.isIdentifier(indexParam, { name: path.node.value.expression.name })
        )
          return;
        const call = callback.parentPath;
        if (
          !call?.isCallExpression() ||
          !t.isMemberExpression(call.node.callee) ||
          !t.isIdentifier(call.node.callee.property, { name: "map" })
        )
          return;
        emit(
          ctx,
          path.node,
          "REACT-005",
          "MEDIUM",
          "A list item uses the array index as its React key.",
          "Indexes change when items are inserted, removed, or reordered, so React can preserve state on the wrong item.",
          "Use a stable identifier from the item, such as item.id, as the key.",
        );
      },
    });
  },
};

function effectHasEmptyDependencies(path: NodePath<t.CallExpression>): boolean {
  const deps = path.node.arguments[1];
  return t.isArrayExpression(deps) && deps.elements.length === 0;
}

export const StaleTimerStateRule: VerificationRule = {
  id: "REACT-006",
  name: "Stale State Update in Effect Timer",
  description:
    "Detects state setters that capture stale state in timers created by an empty-dependency Effect.",
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(effectPath) {
        if (
          !t.isIdentifier(effectPath.node.callee, { name: "useEffect" }) ||
          !effectHasEmptyDependencies(effectPath)
        )
          return;
        const setupPath = effectPath.get("arguments.0");
        if (
          !setupPath.isArrowFunctionExpression() &&
          !setupPath.isFunctionExpression()
        )
          return;
        const component = effectPath.getFunctionParent();
        if (!component) return;
        const pairs = new Map<string, string>();
        component.traverse({
          VariableDeclarator(bindingPath) {
            if (bindingPath.getFunctionParent() !== component) return;
            if (
              !t.isArrayPattern(bindingPath.node.id) ||
              !t.isCallExpression(bindingPath.node.init) ||
              !t.isIdentifier(bindingPath.node.init.callee, {
                name: "useState",
              })
            )
              return;
            const [state, setter] = bindingPath.node.id.elements;
            if (t.isIdentifier(state) && t.isIdentifier(setter))
              pairs.set(setter.name, state.name);
          },
        });
        setupPath.traverse({
          CallExpression(timerPath) {
            if (
              !t.isIdentifier(timerPath.node.callee) ||
              !["setInterval", "setTimeout"].includes(
                timerPath.node.callee.name,
              )
            )
              return;
            const callbackPath = timerPath.get("arguments.0");
            if (
              !callbackPath.isArrowFunctionExpression() &&
              !callbackPath.isFunctionExpression()
            )
              return;
            callbackPath.traverse({
              CallExpression(setterPath) {
                if (!t.isIdentifier(setterPath.node.callee)) return;
                const stateName = pairs.get(setterPath.node.callee.name);
                const value = setterPath.node.arguments[0];
                if (!stateName || !t.isExpression(value)) return;
                let captures = false;
                setterPath.get("arguments.0").traverse({
                  Identifier(identifierPath) {
                    if (identifierPath.node.name === stateName) captures = true;
                  },
                });
                if (!captures) return;
                emit(
                  ctx,
                  setterPath.node,
                  "REACT-006",
                  "HIGH",
                  `Timer update captures stale '${stateName}' state.`,
                  "The empty dependency Effect creates the callback once, so it keeps reading the initial state value.",
                  `Use the functional updater form ${setterPath.node.callee.name}(current => ...) instead.`,
                );
              },
            });
          },
        });
      },
    });
  },
};

export const FlatListIndexKeyRule: VerificationRule = {
  id: "RN-COR-001",
  name: "FlatList Index Key",
  description:
    "Detects FlatList and SectionList key extractors that return the item index.",
  category: "REACT_NATIVE_EXPO",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      JSXOpeningElement(path) {
        if (
          !t.isJSXIdentifier(path.node.name) ||
          !["FlatList", "SectionList"].includes(path.node.name.name)
        )
          return;
        const attribute = jsxAttribute(path.node, "keyExtractor");
        if (!attribute || !t.isJSXExpressionContainer(attribute.value)) return;
        const fn = attribute.value.expression;
        if (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn))
          return;
        const index = fn.params[1];
        if (!t.isIdentifier(index)) return;
        const body = fn.body;
        const returnsIndex =
          t.isIdentifier(body, { name: index.name }) ||
          (t.isCallExpression(body) &&
            t.isIdentifier(body.callee, { name: "String" }) &&
            t.isIdentifier(body.arguments[0], { name: index.name })) ||
          (t.isCallExpression(body) &&
            t.isMemberExpression(body.callee) &&
            t.isIdentifier(body.callee.object, { name: index.name }) &&
            t.isIdentifier(body.callee.property, { name: "toString" }));
        if (!returnsIndex) return;
        emit(
          ctx,
          attribute,
          "RN-COR-001",
          "MEDIUM",
          "Virtualized list uses the item index as its key.",
          "Index keys are unstable under insertion and reordering, which can associate cached rows or component state with the wrong item.",
          "Return a stable unique item identifier from keyExtractor.",
        );
      },
    });
  },
};

// =========================================================================
// React Native animation / gesture correctness
// =========================================================================

const ANIMATION_GROUP_NAMES = new Set(["parallel", "sequence", "stagger"]);
const ANIMATION_NODE_NAMES = new Set(["timing", "spring", "decay"]);
const MAX_ANIMATION_GROUP_DEPTH = 8;
const MAX_ANIMATION_GROUP_CHILDREN = 64;

/** Returns the Animated.<name> API name for a call expression, or null. */
function animatedCallName(node: t.Node): string | null {
  if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee))
    return null;
  if (
    !t.isIdentifier(node.callee.object, { name: "Animated" }) ||
    !t.isIdentifier(node.callee.property)
  )
    return null;
  const name = node.callee.property.name;
  return ANIMATION_GROUP_NAMES.has(name) || ANIMATION_NODE_NAMES.has(name)
    ? name
    : null;
}

/** Explicit boolean `useNativeDriver` literal from an animation config, or null when unknown. */
function explicitDriver(config: t.Node | null | undefined): boolean | null {
  if (!config || !t.isObjectExpression(config)) return null;
  for (const prop of config.properties) {
    if (
      t.isObjectProperty(prop) &&
      !prop.computed &&
      t.isIdentifier(prop.key, { name: "useNativeDriver" }) &&
      t.isBooleanLiteral(prop.value)
    ) {
      return prop.value.value;
    }
  }
  return null;
}

function groupAnimations(call: t.CallExpression, name: string): t.Node[] {
  const list = call.arguments[name === "stagger" ? 1 : 0];
  if (!t.isArrayExpression(list)) return [];
  return list.elements.filter(
    (element): element is t.Expression | t.SpreadElement => element !== null,
  );
}

/**
 * Map of `const x = Animated.timing(...)` declarations, used to resolve bare
 * identifier children inside a group. A name declared more than once maps to
 * null (ambiguous → unknown).
 */
function collectAnimatedDeclarations(
  ctx: RuleContext,
): Map<string, t.CallExpression | null> {
  const declarations = new Map<string, t.CallExpression | null>();
  traverse(ctx.ast, {
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!t.isIdentifier(path.node.id) || !t.isCallExpression(init)) return;
      if (!animatedCallName(init)) return;
      const name = path.node.id.name;
      declarations.set(name, declarations.has(name) ? null : init);
    },
  });
  return declarations;
}

function collectDrivers(
  node: t.Node,
  declarations: Map<string, t.CallExpression | null>,
  depth: number,
  drivers: boolean[],
): void {
  if (
    depth > MAX_ANIMATION_GROUP_DEPTH ||
    drivers.length > MAX_ANIMATION_GROUP_CHILDREN
  )
    return;
  if (t.isIdentifier(node)) {
    const resolved = declarations.get(node.name);
    if (!resolved) return;
    node = resolved;
  }
  const name = animatedCallName(node);
  if (!name) return;
  const call = node as t.CallExpression;
  if (ANIMATION_NODE_NAMES.has(name)) {
    const driver = explicitDriver(call.arguments[1]);
    if (driver !== null) drivers.push(driver);
    return;
  }
  for (const child of groupAnimations(call, name))
    collectDrivers(child, declarations, depth + 1, drivers);
}

export const MixedNativeDriverRule: VerificationRule = {
  id: "RN-COR-002",
  name: "Mixed Native Driver in Animation Group",
  description:
    "Detects Animated.parallel/sequence/stagger groups whose children mix useNativeDriver values.",
  category: "REACT_NATIVE_EXPO",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    const declarations = collectAnimatedDeclarations(ctx);
    traverse(ctx.ast, {
      CallExpression(path) {
        const name = animatedCallName(path.node);
        if (!name || !ANIMATION_GROUP_NAMES.has(name)) return;
        const drivers: boolean[] = [];
        collectDrivers(path.node, declarations, 0, drivers);
        if (!drivers.includes(true) || !drivers.includes(false)) return;
        const nativeCount = drivers.filter((driver) => driver).length;
        emit(
          ctx,
          path.node,
          "RN-COR-002",
          "MEDIUM",
          `Animated.${name} mixes useNativeDriver values (${nativeCount} native-driven, ${drivers.length - nativeCount} JS-driven).`,
          "Native-driven animations run on the UI thread while JS-driven ones run on the JS thread, so a mixed group cannot start, stop, or synchronize atomically; the animations drift apart whenever the JS thread is busy, and interrupting the group leaves them out of step.",
          "Give every animation in the group the same useNativeDriver value. A value driven from JS (e.g. updated with setValue during a gesture) forces useNativeDriver: false for the whole group.",
        );
      },
    });
  },
};

function useRefDeclarationCounts(ctx: RuleContext): Map<string, number> {
  const counts = new Map<string, number>();
  traverse(ctx.ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !t.isCallExpression(path.node.init))
        return;
      if (!t.isIdentifier(path.node.init.callee, { name: "useRef" })) return;
      const name = path.node.id.name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    },
  });
  return counts;
}

function consequentReturns(consequent: t.Statement): boolean {
  if (t.isReturnStatement(consequent)) return true;
  return (
    t.isBlockStatement(consequent) &&
    consequent.body.length > 0 &&
    consequent.body.every((statement) => t.isReturnStatement(statement))
  );
}

function firstCallbackParamNames(
  callback: t.ArrowFunctionExpression | t.FunctionExpression,
): { self: string | null; destructured: Set<string> } {
  const param = callback.params[0];
  const destructured = new Set<string>();
  if (!param) return { self: null, destructured };
  if (t.isIdentifier(param)) return { self: param.name, destructured };
  if (t.isObjectPattern(param)) {
    for (const prop of param.properties) {
      if (t.isObjectProperty(prop) && t.isIdentifier(prop.value))
        destructured.add(prop.value.name);
    }
  }
  return { self: null, destructured };
}

/** Matches `if (!finished) return;` and `if (!result.finished) return;` style interrupt guards. */
function isInterruptGuard(
  test: t.Node,
  params: { self: string | null; destructured: Set<string> },
): boolean {
  if (!t.isUnaryExpression(test, { operator: "!" })) return false;
  const argument = test.argument;
  if (t.isIdentifier(argument)) {
    return (
      params.destructured.has(argument.name) ||
      (params.self !== null && argument.name === params.self)
    );
  }
  if (
    t.isMemberExpression(argument) &&
    t.isIdentifier(argument.object) &&
    t.isIdentifier(argument.property)
  ) {
    return params.self !== null && argument.object.name === params.self;
  }
  return false;
}

/**
 * True when the completion callback clears the latch, but every clear sits
 * after an interrupt guard — i.e. an interrupted animation skips every reset.
 */
function latchStuckOnInterruption(
  callbackPath: NodePath,
  refName: string,
): boolean {
  const callback = callbackPath.node as
    | t.ArrowFunctionExpression
    | t.FunctionExpression;
  const params = firstCallbackParamNames(callback);
  const guards: t.IfStatement[] = [];
  callbackPath.traverse({
    IfStatement(ifPath) {
      if (
        guards.length > 0 ||
        !consequentReturns(ifPath.node.consequent) ||
        !isInterruptGuard(ifPath.node.test, params)
      )
        return;
      guards.push(ifPath.node);
    },
  });
  const guard = guards[0];
  if (!guard) return false;
  const guardEnd = guard.end;
  let sawReset = false;
  let allResetsAfterGuard = true;
  callbackPath.traverse({
    AssignmentExpression(resetPath) {
      const reset = resetPath.node;
      if (
        reset.operator !== "=" ||
        !t.isBooleanLiteral(reset.right, { value: false })
      )
        return;
      const left = reset.left;
      if (
        !t.isMemberExpression(left) ||
        !t.isIdentifier(left.object, { name: refName }) ||
        !t.isIdentifier(left.property, { name: "current" })
      )
        return;
      sawReset = true;
      if (
        !(
          typeof guardEnd === "number" &&
          typeof reset.start === "number" &&
          reset.start > guardEnd
        )
      ) {
        allResetsAfterGuard = false;
      }
    },
  });
  return sawReset && allResetsAfterGuard;
}

export const AnimationLatchStuckRule: VerificationRule = {
  id: "RN-COR-003",
  name: "Animation Latch Never Reset on Interruption",
  description:
    "Detects ref latches set before an animation starts that are only cleared on the finished path of the completion callback.",
  category: "REACT_NATIVE_EXPO",
  defaultSeverity: "HIGH",
  check(ctx) {
    const refCounts = useRefDeclarationCounts(ctx);
    traverse(ctx.ast, {
      AssignmentExpression(path) {
        const setTrue = path.node;
        if (
          setTrue.operator !== "=" ||
          !t.isBooleanLiteral(setTrue.right, { value: true })
        )
          return;
        const left = setTrue.left;
        if (
          !t.isMemberExpression(left) ||
          !t.isIdentifier(left.object) ||
          !t.isIdentifier(left.property, { name: "current" })
        )
          return;
        const refName = left.object.name;
        if (refCounts.get(refName) !== 1) return;
        const fn = path.getFunctionParent();
        if (!fn) return;
        const startCalls: NodePath<t.CallExpression>[] = [];
        fn.traverse({
          CallExpression(startPath) {
            if (startPath.getFunctionParent()?.node !== fn.node) return;
            if (
              !t.isMemberExpression(startPath.node.callee) ||
              !t.isIdentifier(startPath.node.callee.property, { name: "start" })
            )
              return;
            const lastArgument =
              startPath.node.arguments[startPath.node.arguments.length - 1];
            if (
              !t.isArrowFunctionExpression(lastArgument) &&
              !t.isFunctionExpression(lastArgument)
            )
              return;
            if (
              typeof startPath.node.start === "number" &&
              typeof setTrue.end === "number" &&
              startPath.node.start < setTrue.end
            )
              return;
            startCalls.push(startPath);
          },
        });
        for (const startPath of startCalls) {
          const callbackPath = startPath.get(
            `arguments.${startPath.node.arguments.length - 1}`,
          );
          if (latchStuckOnInterruption(callbackPath, refName)) {
            emit(
              ctx,
              setTrue,
              "RN-COR-003",
              "HIGH",
              `Ref latch '${refName}.current' is set before an animation starts and only cleared when the animation reports finished.`,
              `If the animation is interrupted (stopAnimation, a competing gesture, unmount cleanup), the completion callback runs with finished: false and the early return skips the reset, leaving '${refName}.current' stuck at true. Every later operation guarded by this latch is then silently skipped.`,
              `Clear the latch on every callback path — set '${refName}.current = false' before the finished check, or inside the !finished branch before returning.`,
            );
            return;
          }
        }
      },
    });
  },
};

export const PanResponderCaptureRule: VerificationRule = {
  id: "RN-COR-004",
  name: "Capture-Phase Pan Responder Steals All Touches",
  description:
    "Detects PanResponder.create with onStartShouldSetPanResponderCapture returning constant true.",
  category: "REACT_NATIVE_EXPO",
  defaultSeverity: "LOW",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (
          !t.isMemberExpression(callee) ||
          !t.isIdentifier(callee.object, { name: "PanResponder" }) ||
          !t.isIdentifier(callee.property, { name: "create" })
        )
          return;
        const config = path.node.arguments[0];
        if (!t.isObjectExpression(config)) return;
        for (const prop of config.properties) {
          if (
            !t.isObjectProperty(prop) ||
            !t.isIdentifier(prop.key, {
              name: "onStartShouldSetPanResponderCapture",
            })
          )
            continue;
          const fn = prop.value;
          if (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn))
            continue;
          const alwaysTrue =
            t.isBooleanLiteral(fn.body, { value: true }) ||
            (t.isBlockStatement(fn.body) &&
              fn.body.body.length > 0 &&
              fn.body.body.every(
                (statement) =>
                  t.isReturnStatement(statement) &&
                  t.isBooleanLiteral(statement.argument, { value: true }),
              ));
          if (!alwaysTrue) continue;
          emit(
            ctx,
            prop,
            "RN-COR-004",
            "LOW",
            "onStartShouldSetPanResponderCapture returns true for every touch, claiming the responder in the capture phase before children see it.",
            "Capture-phase handlers run top-down before any child; a constant true steals touches from buttons, inputs, and scrollables inside the responder view, so they never receive presses.",
            "Return the constant from onStartShouldSetPanResponder (bubble phase) instead, or gate it on the gesture target (e.g. only touches on the drag handle or backdrop).",
          );
        }
      },
    });
  },
};

export const RefAccessDuringRenderRule: VerificationRule = {
  id: "REACT-007",
  name: "Ref Accessed During Render",
  description:
    'Detects reads or writes of a useRef-backed .current value in a component or hook body outside of nested callbacks — React 19.2+ throws "Cannot access refs during render".',
  category: "REACT_HOOKS",
  defaultSeverity: "HIGH",
  check(ctx) {
    const declaredRefs = declaredRefNames(ctx);
    traverse(ctx.ast, {
      MemberExpression(path) {
        const { property, object } = path.node;
        const isCurrent = path.node.computed
          ? t.isStringLiteral(property, { value: "current" })
          : t.isIdentifier(property, { name: "current" });
        if (!isCurrent) return;
        // Restrict to provable refs: a useRef(...) call, or a variable declared
        // from useRef in this file. Unprovable .current fields stay unflagged.
        const fromUseRefCall =
          t.isCallExpression(object) &&
          t.isIdentifier(object.callee, { name: "useRef" });
        const refName = t.isIdentifier(object) ? object.name : null;
        if (!fromUseRefCall && !(refName !== null && declaredRefs.has(refName)))
          return;
        const owner = path.getFunctionParent();
        if (!owner || !t.isFunction(owner.node)) return;
        // The nearest enclosing function decides the phase: if it is a nested
        // callback (Effect, handler, animation completion), the access runs after
        // render and is legal. If it is the component/hook body, it runs during render.
        if (!callsHookOrRendersJsx(owner.node)) return;
        const target =
          refName !== null ? `'${refName}.current'` : "useRef(...).current";
        emit(
          ctx,
          path.node,
          "REACT-007",
          "HIGH",
          `${target} is accessed during render.`,
          'Refs are imperative escapes and are not safe to read or write while rendering: React 19.2+ throws "Cannot access refs during render" in development, and the React Compiler requires render to be ref-free. Accesses inside Effects, event handlers, and other callbacks are fine — only render-phase access is rejected. useRef(new Animated.Value(1)).current was previously an accepted idiom for Animated values; React 19.2 turned it into a runtime error.',
          "Hoist the value out of the ref: useState(() => new Animated.Value(1))[0] for a stable per-instance value, a module-level constant when stateless, or keep the ref and move every .current access into Effects and event handlers.",
        );
      },
    });
  },
};

/** Names of variables declared directly from useRef(...) in this file. */
function declaredRefNames(ctx: RuleContext): Set<string> {
  const names = new Set<string>();
  traverse(ctx.ast, {
    VariableDeclarator(path) {
      if (
        t.isIdentifier(path.node.id) &&
        t.isCallExpression(path.node.init) &&
        t.isIdentifier(path.node.init.callee, { name: "useRef" })
      )
        names.add(path.node.id.name);
    },
  });
  return names;
}

/**
 * True when the function is a component or hook: it directly calls a use*
 * hook or renders JSX. Nested functions do not qualify their enclosing scope.
 */
function callsHookOrRendersJsx(fn: t.Function): boolean {
  let found = false;
  const walk = (node: t.Node | null | undefined): void => {
    if (!node || found || !node.type) return;
    if (node !== fn.body && t.isFunction(node)) return;
    if (
      node.type === "CallExpression" &&
      t.isIdentifier(node.callee) &&
      /^use[A-Z]/.test(node.callee.name)
    ) {
      found = true;
      return;
    }
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      found = true;
      return;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) value.forEach((child) => walk(child as t.Node));
      else walk(value as t.Node);
    }
  };
  walk(fn.body);
  return found;
}

export const UnusedStateRule: VerificationRule = {
  id: "REACT-008",
  name: "Unused State Variable",
  description:
    "Detects useState pairs whose value is never read, or whose setter is never called.",
  category: "REACT_HOOKS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    const jsxNames = collectJsxIdentifierNames(ctx);
    traverse(ctx.ast, {
      VariableDeclarator(path) {
        const { id, init } = path.node;
        if (!t.isArrayPattern(id)) return;
        const [state, setter] = id.elements;
        const isUseState =
          t.isCallExpression(init) &&
          (t.isIdentifier(init.callee, { name: "useState" }) ||
            (t.isMemberExpression(init.callee) &&
              t.isIdentifier(init.callee.property, { name: "useState" })));
        if (!isUseState) return;
        const report = (
          severity: "MEDIUM" | "LOW",
          message: string,
          explanation: string,
          remediation: string,
        ): void => {
          const loc = nodeToLocation(path.node);
          ctx.report({
            id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:REACT-008`,
            ruleId: "REACT-008",
            category: "REACT_HOOKS",
            severity,
            message,
            explanation,
            loc,
            codeSnippet: extractCodeSnippet(ctx.lines, loc),
            remediation: { summary: remediation, llmPromptHint: remediation },
          });
        };
        if (
          t.isIdentifier(state) &&
          !state.name.startsWith("_") &&
          !jsxNames.has(state.name)
        ) {
          const binding = path.scope.getBinding(state.name);
          if (binding && binding.references === 0) {
            report(
              "MEDIUM",
              `State variable '${state.name}' is declared but never read.`,
              `Either this is dead code, or — more commonly — a bug: '${state.name}' holds data the screen was meant to display or branch on, and updates via its setter are silently invisible because nothing renders or checks it. Unused state also costs a re-render on every update.`,
              `Remove the unused state, or read '${state.name}' where it matters (render, Effect, or handler). If updates were expected to show up, find the place where the UI should consume '${state.name}'.`,
            );
          }
        }
        if (t.isIdentifier(setter) && !setter.name.startsWith("_")) {
          const binding = path.scope.getBinding(setter.name);
          if (binding && binding.references === 0) {
            report(
              "LOW",
              `State '${state && t.isIdentifier(state) ? state.name : "value"}' is never updated — its setter '${setter.name}' is never called.`,
              `The state is initialized once and can never change, so it behaves as a constant while still costing a state slot and re-render plumbing.`,
              `Replace the state with a plain constant, or call '${setter.name}' where the value is meant to change (handlers, Effects, subscriptions).`,
            );
          }
        }
      },
    });
  },
};

/** All JSX tag and attribute-identifier names in the file, used as a conservative "may be referenced" set. */
export function collectJsxIdentifierNames(ctx: RuleContext): Set<string> {
  const names = new Set<string>();
  traverse(ctx.ast, {
    JSXIdentifier(path) {
      names.add(path.node.name);
    },
  });
  return names;
}

export const REACT_CORRECTNESS_RULES: VerificationRule[] = [
  AsyncEffectRule,
  ArrayIndexKeyRule,
  StaleTimerStateRule,
  FlatListIndexKeyRule,
  MixedNativeDriverRule,
  AnimationLatchStuckRule,
  PanResponderCaptureRule,
  RefAccessDuringRenderRule,
  UnusedStateRule,
];
