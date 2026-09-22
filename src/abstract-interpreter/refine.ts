import * as t from '@babel/types';
import { MemoryAbstractState } from '../types/verifier';
import { MemoryState, NullabilityDomain } from './domain';
import { SymbolTable } from './symbols';

/**
 * Path-sensitive refinement of abstract memory states along CFG edges.
 *
 * When the CFG builder labels an edge with the branch condition that guards
 * it, the fixpoint uses `refineState` to narrow the predecessor's outgoing
 * state before joining — e.g. the false edge of `if (user === null)` proves
 * `user` is non-null on that path, eliminating downstream false positives.
 */
export function refineState(
  state: MemoryAbstractState,
  test: t.Node | undefined | null,
  polarity: boolean,
  symbols?: SymbolTable
): MemoryAbstractState {
  if (!test || !t.isExpression(test)) return state;
  const next = MemoryState.clone(state);
  refineExpression(next, test, polarity, 0, symbols);
  return next;
}

const MAX_REFINE_DEPTH = 8;

function refineExpression(
  state: MemoryAbstractState,
  expr: t.Expression,
  polarity: boolean,
  depth: number,
  symbols?: SymbolTable
): void {
  if (depth > MAX_REFINE_DEPTH) return;

  // A non-optional member read evaluated in the test proves its base is
  // non-null: evaluating `x.y` on a null x would have THROWN before the
  // branch — so both branches imply x was non-null at evaluation time.
  if (isMemberLike(expr) && !expr.optional) {
    const base = baseIdentifierOf(expr);
    if (base) {
      setNonNull(state, base, symbols);
      return;
    }
  }

  // `if (x?.y)` truthy ⇒ the optional chain succeeded ⇒ x is non-null.
  // Falsy proves nothing (the chain short-circuits without throwing).
  if (isMemberLike(expr) && expr.optional) {
    const base = baseIdentifierOf(expr);
    if (base && polarity) setNonNull(state, base, symbols);
    return;
  }

  // `if (x)` truthy => x is non-null; falsy proves nothing (x could be 0 or '')
  if (t.isIdentifier(expr)) {
    if (polarity) setNonNull(state, expr, symbols);
    return;
  }

  // `if (!x)` — flip the polarity
  if (t.isUnaryExpression(expr) && expr.operator === '!') {
    refineExpression(state, expr.argument, !polarity, depth + 1, symbols);
    return;
  }

  // `x !== null` / `x != null` / `x !== undefined`
  if (t.isBinaryExpression(expr) && expr.operator === '!==') {
    const nullishSide =
      t.isNullLiteral(expr.right) || isUndefinedIdentifier(expr.right)
        ? 'right'
        : t.isNullLiteral(expr.left) || isUndefinedIdentifier(expr.left)
          ? 'left'
          : null;
    if (nullishSide) {
      const variable = nullishSide === 'right'
        ? t.isIdentifier(expr.left) ? expr.left : null
        : t.isIdentifier(expr.right) ? expr.right : null;
      const undefinedSide = isUndefinedIdentifier(nullishSide === 'right' ? expr.right : expr.left);
      if (variable) {
        if (polarity) setNonNull(state, variable, symbols);
        else setNullability(state, variable, undefinedSide ? 'Undefined' : 'Null', symbols);
      }
      return;
    }
  }

  // `x != null` / `x != undefined` (loose) — true ⇒ non-nullish.
  if (t.isBinaryExpression(expr) && expr.operator === '!=') {
    if (isNullish(expr.right) || isNullish(expr.left)) {
      const variable = t.isIdentifier(expr.left)
        ? expr.left
        : t.isIdentifier(expr.right)
          ? expr.right
          : null;
      if (variable) {
        if (polarity) setNonNull(state, variable, symbols);
        else setNullability(state, variable, 'Nullable', symbols);
      }
    }
    return;
  }

  // `typeof x === 'undefined'` / `typeof x !== 'undefined'`
  if (t.isBinaryExpression(expr) && (expr.operator === '===' || expr.operator === '!==')) {
    const typeofSide = t.isUnaryExpression(expr.left, { operator: 'typeof' })
      ? 'left'
      : t.isUnaryExpression(expr.right, { operator: 'typeof' })
        ? 'right'
        : null;
    if (typeofSide) {
      const other = typeofSide === 'left' ? expr.right : expr.left;
      if (t.isStringLiteral(other)) {
        const arg =
          typeofSide === 'left'
            ? (expr.left as t.UnaryExpression).argument
            : (expr.right as t.UnaryExpression).argument;
        const variable = t.isIdentifier(arg) ? arg : null;
        if (variable && other.value === 'undefined') {
          const isUndefined = (expr.operator === '===') === polarity;
          if (isUndefined) setNullability(state, variable, 'Undefined', symbols);
          else setNonNull(state, variable, symbols);
        } else {
          const equalityHolds = (expr.operator === '===') === polarity;
          // Any successful typeof comparison against a concrete runtime type
          // other than "undefined" proves the value is non-nullish.
          if (variable && equalityHolds) setNonNull(state, variable, symbols);
        }
      }
      return;
    }
  }

  // Relational comparisons (`<`, `>`, `<=`, `>=`, `in`, `instanceof`): both
  // operands were evaluated — narrow member-read bases on each side
  // (e.g. `arr.length > 0` proves arr non-null).
  if (
    t.isBinaryExpression(expr) &&
    ['<', '>', '<=', '>=', 'in', 'instanceof'].includes(expr.operator)
  ) {
    narrowMemberBases(state, expr.left, depth + 1, symbols);
    narrowMemberBases(state, expr.right, depth + 1, symbols);
    return;
  }

  // `x == null` (loose) matches both null and undefined
  if (t.isBinaryExpression(expr) && expr.operator === '==' && isNullish(expr.right)) {
    const variable = t.isIdentifier(expr.left) ? expr.left : null;
    if (variable) {
      if (polarity) setNullability(state, variable, 'Nullable', symbols);
      else setNonNull(state, variable, symbols);
    }
    return;
  }

  // `x === null` / `x === undefined` / `x === someNullVar`
  if (t.isBinaryExpression(expr) && (expr.operator === '===' || expr.operator === '==')) {
    if (t.isNullLiteral(expr.right) || isNullish(expr.right)) {
      const variable = t.isIdentifier(expr.left) ? expr.left : null;
      if (variable) {
        if (polarity) setNullability(state, variable, t.isNullLiteral(expr.right) ? 'Null' : 'Nullable', symbols);
        else setNonNull(state, variable, symbols);
      }
      return;
    }
    if (isUndefinedIdentifier(expr.right) || isUndefinedIdentifier(expr.left)) {
      const variable = t.isIdentifier(expr.left) ? expr.left : t.isIdentifier(expr.right) ? expr.right : null;
      if (variable) {
        if (polarity) setNullability(state, variable, 'Undefined', symbols);
        else setNonNull(state, variable, symbols);
      }
      return;
    }
    return;
  }

  // `a && b` assumed true refines both sides; assumed false proves nothing
  if (t.isLogicalExpression(expr) && expr.operator === '&&') {
    if (polarity) {
      refineExpression(state, expr.left, true, depth + 1, symbols);
      refineExpression(state, expr.right, true, depth + 1, symbols);
    }
    return;
  }

  // `a || b` assumed false refines both sides; assumed true proves nothing
  if (t.isLogicalExpression(expr) && expr.operator === '||') {
    if (!polarity) {
      refineExpression(state, expr.left, false, depth + 1, symbols);
      refineExpression(state, expr.right, false, depth + 1, symbols);
    }
    return;
  }

  // `x ?? fallback` assumed true (well-defined) implies x is non-nullish
  if (t.isLogicalExpression(expr) && expr.operator === '??') {
    if (polarity && t.isIdentifier(expr.left)) setNonNull(state, expr.left, symbols);
    return;
  }
}

function setNonNull(state: MemoryAbstractState, variable: t.Identifier, symbols?: SymbolTable): void {
  setNullability(state, variable, 'NonNull', symbols);
}

function setNullability(state: MemoryAbstractState, variable: t.Identifier, value: any, symbols?: SymbolTable): void {
  const key = symbols?.key(variable) ?? variable.name;
  const current = MemoryState.get(state, key);
  // Refinement runs on a per-edge clone, so narrowing a definite fact is
  // sound: `if (!x) return;` proves x is non-null on the fall-through even
  // when x was Null before (that fact describes OTHER paths). We only refuse
  // to WEAKEN an existing concrete fact (Null -> Nullable etc.).
  if (value === 'NonNull') {
    state.set(key, { ...current, nullability: value });
    return;
  }
  if (current.nullability !== 'Top' && current.nullability !== 'Bottom') return;
  state.set(key, { ...current, nullability: value });
}

function isUndefinedIdentifier(expr: t.Node): boolean {
  return t.isIdentifier(expr) && expr.name === 'undefined';
}

/**
 * Narrows identifier bases of NON-optional member reads that definitely
 * evaluated (operand position in a comparison). `a.b.c` -> narrows `a`.
 */
function narrowMemberBases(
  state: MemoryAbstractState,
  expr: t.Node,
  depth: number,
  symbols?: SymbolTable
): void {
  if (!expr || depth > MAX_REFINE_DEPTH) return;
  if (isMemberLike(expr)) {
    if (!expr.optional) {
      const base = baseIdentifierOf(expr);
      if (base) setNonNull(state, base, symbols);
    }
    return;
  }
  if (t.isUnaryExpression(expr) && expr.operator === '!') {
    narrowMemberBases(state, expr.argument, depth + 1, symbols);
  }
}

/** `a.b.c` -> `a` (root identifier of a member chain). */
function baseIdentifierOf(
  expr: t.MemberExpression | t.OptionalMemberExpression
): t.Identifier | null {
  let cur: t.Expression = expr;
  while (isMemberLike(cur)) cur = cur.object;
  return t.isIdentifier(cur) ? cur : null;
}

/** `x?.y` is a distinct Babel node type — every member check needs both. */
function isMemberLike(
  expr: t.Node
): expr is t.MemberExpression | t.OptionalMemberExpression {
  return t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr);
}

function isNullish(expr: t.Node): boolean {
  return t.isNullLiteral(expr) || isUndefinedIdentifier(expr);
}

export const NullabilityRefiner = { refineState };
