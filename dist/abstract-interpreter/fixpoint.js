"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AbstractInterpreter = void 0;
const t = __importStar(require("@babel/types"));
const domain_1 = require("./domain");
const refine_1 = require("./refine");
const ts_types_1 = require("./ts-types");
const symbols_1 = require("./symbols");
// Widening kicks in after this many visits to the same node — loop headers
// typically stabilize within 2-3 iterations, so this keeps precision on
// straight-line joins while guaranteeing termination everywhere.
const FORCE_WIDEN_AFTER = 4;
// Hard per-node safety cap. Hitting it marks the CFG as truncated rather
// than failing silently.
const MAX_VISITS_PER_NODE = 200;
class AbstractInterpreter {
    functionSummaries;
    symbols;
    constructor(functionSummaries = new Map(), symbols = new symbols_1.SymbolTable()) {
        this.functionSummaries = functionSummaries;
        this.symbols = symbols;
    }
    /**
     * Runs the worklist fixed-point algorithm on a Control Flow Graph.
     * Terminates via widening; `cfg.truncated` is set if the safety cap bit.
     */
    analyze(cfg, initialState) {
        cfg.statementStates = new Map();
        // Seed the entry state (e.g. TypeScript-annotated nullable parameters) so
        // the whole function body analyzes against those facts.
        const entryNode = cfg.nodes.get(cfg.entryNodeId);
        if (initialState && initialState.size > 0 && entryNode) {
            entryNode.stateIn = domain_1.MemoryState.clone(initialState);
        }
        const worklist = [cfg.entryNodeId];
        const visits = new Map();
        const inWorklist = new Set(worklist);
        const visitedOnce = new Set();
        let truncated = false;
        while (worklist.length > 0) {
            const nodeId = worklist.shift();
            inWorklist.delete(nodeId);
            const node = cfg.nodes.get(nodeId);
            if (!node)
                continue;
            const visitCount = (visits.get(nodeId) ?? 0) + 1;
            visits.set(nodeId, visitCount);
            if (visitCount > MAX_VISITS_PER_NODE) {
                truncated = true;
                continue;
            }
            // 1. Compute stateIn by joining (refined) outputs of all predecessors.
            //    An empty accumulator is handled by the domain join (identity ⊥).
            let joinedIn;
            for (const predId of node.predecessors) {
                const pred = cfg.nodes.get(predId);
                if (!pred)
                    continue;
                let predOut = domain_1.MemoryState.clone(pred.stateOut);
                // Path-sensitive refinement: narrow the predecessor's state to what
                // must hold on THIS edge (e.g. `x !== null` on the false branch).
                const edge = cfg.edgeConditions?.get(`${predId}->${nodeId}`);
                if (edge) {
                    predOut = (0, refine_1.refineState)(predOut, edge.test, edge.polarity, this.symbols);
                }
                joinedIn = joinedIn ? domain_1.MemoryState.join(joinedIn, predOut) : predOut;
            }
            if (joinedIn) {
                const mustWiden = visitCount > FORCE_WIDEN_AFTER || (node.isLoopHeader && visitCount > 1);
                node.stateIn = mustWiden
                    ? domain_1.MemoryState.widen(node.stateIn, joinedIn)
                    : domain_1.MemoryState.join(node.stateIn, joinedIn);
            }
            // 2. Transfer function: execute statements in this block
            const nextOut = this.transfer(node, node.stateIn, cfg.statementStates);
            // 3. Re-enqueue successors when stateOut changed — AND on the first
            //    visit. Without the first-visit rule, a node whose transfer leaves
            //    stateOut unchanged (e.g. an entry node holding only an `if`,
            //    where the initial empty stateOut equals the produced empty state)
            //    would never enqueue its successors and the whole downstream body
            //    would silently go un-analyzed.
            const firstVisit = !visitedOnce.has(nodeId);
            visitedOnce.add(nodeId);
            if (firstVisit || !domain_1.MemoryState.equals(node.stateOut, nextOut)) {
                node.stateOut = nextOut;
                for (const succId of node.successors) {
                    if (!inWorklist.has(succId)) {
                        worklist.push(succId);
                        inWorklist.add(succId);
                    }
                }
            }
        }
        if (truncated)
            cfg.truncated = true;
    }
    /**
     * Transfer function executing statements sequentially on abstract memory state.
     */
    transfer(node, stateIn, statementStates) {
        const state = domain_1.MemoryState.clone(stateIn);
        for (const stmt of node.statements) {
            if (statementStates) {
                statementStates.set(stmt, domain_1.MemoryState.clone(state));
            }
            this.transferStatement(stmt, state);
        }
        return state;
    }
    transferStatement(stmt, state) {
        if (!stmt || typeof stmt !== 'object')
            return;
        if (t.isVariableDeclaration(stmt)) {
            for (const decl of stmt.declarations) {
                if (!t.isIdentifier(decl.id)) {
                    this.transferDestructuring(decl, state);
                    continue;
                }
                if (decl.init) {
                    this.evaluateExpression(this.symbols.key(decl.id), decl.init, state);
                    // TS annotation fills gaps only: `const u: User | null = api.user`
                    // — the value is unmodeled (Top), but the annotation says it can be
                    // null. A computed NonNull/Null fact is more precise and wins.
                    this.upgradeFromAnnotation(decl.id, state);
                }
                else {
                    // `let x: User | null;` — actually undefined until first assigned.
                    const nul = (0, ts_types_1.annotationNullability)(decl.id.typeAnnotation);
                    if (nul === 'Nullable' || nul === 'Null' || nul === 'Undefined') {
                        domain_1.MemoryState.set(state, this.symbols.key(decl.id), { nullability: 'Undefined' });
                    }
                }
            }
        }
        else if (t.isExpressionStatement(stmt)) {
            this.transferExpressionStatement(stmt.expression, state);
        }
        else if (t.isSwitchCase(stmt)) {
            // Clauses are recorded for bookkeeping; their bodies are walked by the
            // CFG as regular statements, so nothing to evaluate here.
        }
    }
    transferExpressionStatement(expr, state) {
        if (t.isAssignmentExpression(expr) && t.isIdentifier(expr.left)) {
            const key = this.symbols.key(expr.left);
            this.forgetDescendants(state, key);
            this.evaluateExpression(key, expr.right, state);
        }
        else if (t.isAssignmentExpression(expr) && t.isMemberExpression(expr.left)) {
            const key = this.symbols.keyForMember(expr.left);
            if (key) {
                this.forgetDescendants(state, key);
                this.evaluateExpression(key, expr.right, state);
            }
        }
        else if (t.isUpdateExpression(expr) && t.isIdentifier(expr.argument)) {
            const varName = this.symbols.key(expr.argument);
            const current = domain_1.MemoryState.get(state, varName);
            if (current.interval) {
                const delta = expr.operator === '++' ? 1 : -1;
                const newInterval = domain_1.IntervalDomain.add(current.interval, domain_1.IntervalDomain.constant(delta));
                domain_1.MemoryState.set(state, varName, { interval: newInterval });
            }
        }
    }
    /**
     * TS annotation upgrade for `const u: User | null = api.user`.
     * Fills gaps only: a computed NonNull/Null fact is more precise than the
     * annotation and wins; 'Top' (unmodeled) is upgraded to the annotation.
     * Taint/interval survive via the partial-merge in MemoryState.set.
     */
    upgradeFromAnnotation(id, state) {
        const nul = (0, ts_types_1.annotationNullability)(id.typeAnnotation);
        if (nul !== 'Nullable' && nul !== 'Null' && nul !== 'Undefined')
            return;
        const key = this.symbols.key(id);
        const current = domain_1.MemoryState.get(state, key);
        if (current.nullability === 'Top') {
            domain_1.MemoryState.set(state, key, { nullability: nul });
        }
    }
    /**
     * `const [value, setValue] = useState(...)` — the dominant React pattern.
     * The value element gets the nullability of the initializer (or the type
     * argument for `useState<T | null>(x)`); the setter is a function (NonNull).
     */
    transferDestructuring(decl, state) {
        if (!decl.init || !t.isExpression(decl.init))
            return;
        const init = decl.init;
        if (!t.isArrayPattern(decl.id) || !t.isCallExpression(init)) {
            this.propagatePatternValue(decl.id, init, state);
            return;
        }
        const call = init;
        const callee = call.callee;
        const isUseState = (t.isIdentifier(callee) && callee.name === 'useState') ||
            (t.isMemberExpression(callee) &&
                t.isIdentifier(callee.property) &&
                callee.property.name === 'useState');
        const valueEl = decl.id.elements[0];
        const setterEl = decl.id.elements[1];
        if (isUseState && t.isIdentifier(valueEl)) {
            if (t.isExpression(call.arguments[0] ?? null)) {
                this.evaluateExpression(this.symbols.key(valueEl), call.arguments[0], state);
            }
            else {
                // useState<T>() with no argument initializes to undefined.
                domain_1.MemoryState.set(state, this.symbols.key(valueEl), { nullability: 'Undefined' });
            }
            // Type argument fills gaps only (`useState<User | null>(x)`).
            const tyArg = call.typeParameters?.params?.[0];
            const fromType = (0, ts_types_1.annotationNullability)(tyArg);
            if (fromType === 'Nullable' || fromType === 'Null' || fromType === 'Undefined') {
                const cur = domain_1.MemoryState.get(state, this.symbols.key(valueEl));
                if (cur.nullability === 'Top') {
                    domain_1.MemoryState.set(state, this.symbols.key(valueEl), { nullability: fromType });
                }
            }
            if (t.isIdentifier(setterEl)) {
                domain_1.MemoryState.set(state, this.symbols.key(setterEl), { nullability: 'NonNull' });
            }
            return;
        }
        // Generic call destructuring: approximate the first element from the call
        // (picks up taint sources like `const [url] = Linking.useURL()`).
        if (t.isIdentifier(valueEl)) {
            this.evaluateExpression(this.symbols.key(valueEl), call, state);
            const tyArg = call.typeParameters?.params?.[0];
            const fromType = (0, ts_types_1.annotationNullability)(tyArg);
            if (fromType === 'Nullable' || fromType === 'Null' || fromType === 'Undefined') {
                const cur = domain_1.MemoryState.get(state, this.symbols.key(valueEl));
                if (cur.nullability === 'Top') {
                    domain_1.MemoryState.set(state, this.symbols.key(valueEl), { nullability: fromType });
                }
            }
        }
    }
    /**
     * Conservatively propagates the source value to identifiers introduced by
     * object/array destructuring. A selected property has unknown nullability,
     * but it retains taint from the container (route params, storage, etc.).
     */
    propagatePatternValue(pattern, source, state, depth = 0) {
        if (depth > 8)
            return;
        if (t.isVoidPattern(pattern))
            return;
        if (t.isIdentifier(pattern)) {
            const taint = this.extractTaint(source, state);
            domain_1.MemoryState.set(state, this.symbols.key(pattern), { nullability: 'Top', taint });
            return;
        }
        if (t.isAssignmentPattern(pattern)) {
            this.propagatePatternValue(pattern.left, source, state, depth + 1);
            return;
        }
        if (t.isRestElement(pattern)) {
            this.propagatePatternValue(pattern.argument, source, state, depth + 1);
            return;
        }
        if (t.isObjectPattern(pattern)) {
            for (const property of pattern.properties) {
                if (t.isObjectProperty(property)) {
                    this.propagatePatternValue(property.value, source, state, depth + 1);
                }
                else {
                    this.propagatePatternValue(property, source, state, depth + 1);
                }
            }
            return;
        }
        if (t.isArrayPattern(pattern)) {
            for (const element of pattern.elements) {
                if (element)
                    this.propagatePatternValue(element, source, state, depth + 1);
            }
        }
    }
    evaluateExpression(varName, expr, state) {
        // 0. TS wrappers: `x as T` / `x satisfies T` evaluate the inner value.
        // `x!` is a developer non-null assertion — trust it, force NonNull.
        if (t.isTSAsExpression(expr) || t.isTSSatisfiesExpression(expr) || t.isTSTypeAssertion(expr)) {
            this.evaluateExpression(varName, expr.expression, state);
            return;
        }
        if (t.isTSNonNullExpression(expr)) {
            this.evaluateExpression(varName, expr.expression, state);
            domain_1.MemoryState.set(state, varName, { nullability: 'NonNull' });
            return;
        }
        // 1. Numeric literals
        if (t.isNumericLiteral(expr)) {
            domain_1.MemoryState.set(state, varName, {
                interval: domain_1.IntervalDomain.constant(expr.value),
                nullability: 'NonNull',
                taint: domain_1.TaintDomain.CLEAN,
            });
            return;
        }
        // 2. Null / undefined literals
        if (t.isNullLiteral(expr)) {
            domain_1.MemoryState.set(state, varName, { nullability: 'Null', taint: domain_1.TaintDomain.CLEAN });
            return;
        }
        if (t.isIdentifier(expr) && expr.name === 'undefined') {
            domain_1.MemoryState.set(state, varName, { nullability: 'Undefined', taint: domain_1.TaintDomain.CLEAN });
            return;
        }
        // 3. Identifier copy (x = y)
        if (t.isIdentifier(expr)) {
            const sourceVar = domain_1.MemoryState.get(state, this.symbols.key(expr));
            domain_1.MemoryState.set(state, varName, {
                interval: sourceVar.interval ? { ...sourceVar.interval } : undefined,
                nullability: sourceVar.nullability,
                taint: { ...sourceVar.taint },
            });
            return;
        }
        // 4. Values that are provably non-null at creation
        if (t.isStringLiteral(expr) ||
            t.isBooleanLiteral(expr) ||
            t.isObjectExpression(expr) ||
            t.isArrayExpression(expr) ||
            t.isNewExpression(expr) ||
            t.isFunctionExpression(expr) ||
            t.isArrowFunctionExpression(expr) ||
            t.isJSXElement(expr) ||
            t.isJSXFragment(expr) ||
            t.isRegExpLiteral(expr)) {
            domain_1.MemoryState.set(state, varName, {
                nullability: 'NonNull',
                taint: this.extractTaint(expr, state),
            });
            if (t.isObjectExpression(expr))
                this.seedObjectProperties(varName, expr, state);
            return;
        }
        if (t.isTemplateLiteral(expr)) {
            domain_1.MemoryState.set(state, varName, {
                nullability: 'NonNull',
                taint: this.extractTaint(expr, state),
            });
            return;
        }
        // 5. Arithmetic
        if (t.isBinaryExpression(expr) && (expr.operator === '+' || expr.operator === '-')) {
            const leftInterval = this.extractInterval(expr.left, state);
            const rightInterval = this.extractInterval(expr.right, state);
            let resultInterval = domain_1.IntervalDomain.TOP;
            if (leftInterval && rightInterval) {
                resultInterval =
                    expr.operator === '+'
                        ? domain_1.IntervalDomain.add(leftInterval, rightInterval)
                        : domain_1.IntervalDomain.subtract(leftInterval, rightInterval);
            }
            const joinedTaint = domain_1.TaintDomain.join(this.extractTaint(expr.left, state), this.extractTaint(expr.right, state));
            domain_1.MemoryState.set(state, varName, {
                interval: resultInterval,
                nullability: 'NonNull',
                taint: joinedTaint,
            });
            return;
        }
        // 6. `await x` — approximately the nullability/taint of x
        if (t.isAwaitExpression(expr)) {
            this.evaluateExpression(varName, expr.argument, state);
            return;
        }
        // 7. Logical expressions — result is one of the operands
        if (t.isLogicalExpression(expr)) {
            const leftVal = this.abstractValueOf(expr.left, state);
            const rightVal = this.abstractValueOf(expr.right, state);
            let nullability = domain_1.NullabilityDomain.join(leftVal.nullability, rightVal.nullability);
            // `x || fallback`: a truthy x is returned (truthy ⇒ non-null), a falsy
            // x yields the fallback — non-null fallback makes the result non-null.
            if (expr.operator === '||' && rightVal.nullability === 'NonNull') {
                nullability = 'NonNull';
            }
            else if (expr.operator === '??') {
                if (leftVal.nullability === 'NonNull') {
                    // `x ?? y` never touches y when x is non-null.
                    nullability = 'NonNull';
                }
                else if (leftVal.nullability === 'Null' || leftVal.nullability === 'Undefined') {
                    // x is nullish, so the result IS y.
                    nullability = rightVal.nullability;
                }
                else {
                    // x Nullable: the non-nullish part of x is returned (NonNull), the
                    // nullish part falls through to y.
                    nullability = domain_1.NullabilityDomain.join('NonNull', rightVal.nullability);
                }
            }
            domain_1.MemoryState.set(state, varName, {
                nullability,
                taint: domain_1.TaintDomain.join(leftVal.taint, rightVal.taint),
            });
            return;
        }
        if (t.isConditionalExpression(expr)) {
            const consequent = this.abstractValueOf(expr.consequent, state);
            const alternate = this.abstractValueOf(expr.alternate, state);
            domain_1.MemoryState.set(state, varName, {
                nullability: domain_1.NullabilityDomain.join(consequent.nullability, alternate.nullability),
                taint: domain_1.TaintDomain.join(consequent.taint, alternate.taint),
            });
            return;
        }
        // 8. `!x`, `void x`, `typeof x` — boolean/string results are non-null
        if (t.isUnaryExpression(expr)) {
            if (expr.operator === 'void') {
                domain_1.MemoryState.set(state, varName, { nullability: 'Undefined', taint: domain_1.TaintDomain.CLEAN });
            }
            else if (expr.operator === '!' || expr.operator === 'typeof') {
                domain_1.MemoryState.set(state, varName, { nullability: 'NonNull', taint: domain_1.TaintDomain.CLEAN });
            }
            else if (expr.operator === '-' || expr.operator === '+') {
                const interval = this.extractInterval(expr.argument, state);
                domain_1.MemoryState.set(state, varName, {
                    interval: interval
                        ? { min: -interval.max, max: -interval.min }
                        : domain_1.IntervalDomain.TOP,
                    nullability: 'NonNull',
                    taint: domain_1.TaintDomain.CLEAN,
                });
            }
            return;
        }
        // 9. Taint sources (calls + member reads)
        if (t.isCallExpression(expr) || t.isMemberExpression(expr)) {
            if (t.isCallExpression(expr)) {
                const calleeName = summaryCalleeName(expr.callee);
                const summary = calleeName ? this.functionSummaries.get(calleeName) : undefined;
                if (summary?.value) {
                    if (summary.value.kind === 'FIXED') {
                        domain_1.MemoryState.set(state, varName, {
                            nullability: summary.value.nullability,
                            taint: domain_1.TaintDomain.CLEAN,
                        });
                        return;
                    }
                    const argument = expr.arguments[summary.value.parameterIndex];
                    if (argument && t.isExpression(argument)) {
                        let value = this.abstractValueOf(argument, state);
                        if (summary.value.fieldPath?.length && t.isIdentifier(argument)) {
                            value = domain_1.MemoryState.get(state, [this.symbols.key(argument), ...summary.value.fieldPath].join('.'));
                        }
                        domain_1.MemoryState.set(state, varName, {
                            nullability: value.nullability,
                            taint: summary.value.sanitized ? domain_1.TaintDomain.CLEAN : value.taint,
                        });
                        return;
                    }
                }
            }
            const sourceName = this.checkTaintSource(expr);
            if (sourceName) {
                domain_1.MemoryState.set(state, varName, {
                    nullability: 'Top',
                    taint: domain_1.TaintDomain.tainted(sourceName),
                });
                return;
            }
            if (t.isCallExpression(expr) && isTransparentValueCall(expr)) {
                domain_1.MemoryState.set(state, varName, {
                    nullability: 'NonNull',
                    taint: this.extractTaint(expr, state),
                });
                return;
            }
            // Property reads propagate taint from the base object
            // (route.params.untrustedHtml stays tainted via `route`).
            // NOTE: `a?.b` parses as OptionalMemberExpression — a distinct node
            // type — so both forms must be accepted here.
            if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
                const fieldKey = this.symbols.keyForMember(expr);
                if (fieldKey && state.has(fieldKey)) {
                    const field = domain_1.MemoryState.get(state, fieldKey);
                    domain_1.MemoryState.set(state, varName, field);
                    return;
                }
                const base = this.baseIdentifier(expr);
                if (base) {
                    const objTaint = domain_1.MemoryState.get(state, this.symbols.key(base)).taint;
                    if (objTaint.isTainted) {
                        domain_1.MemoryState.set(state, varName, { nullability: 'Top', taint: objTaint });
                        return;
                    }
                }
            }
        }
        // Default fallback: unknown value
        domain_1.MemoryState.set(state, varName, { nullability: 'Top' });
    }
    seedObjectProperties(objectKey, object, state, depth = 0) {
        if (depth > 8)
            return;
        for (const property of object.properties) {
            if (!t.isObjectProperty(property) || !t.isExpression(property.value))
                continue;
            const name = !property.computed && t.isIdentifier(property.key)
                ? property.key.name
                : t.isStringLiteral(property.key) || t.isNumericLiteral(property.key)
                    ? String(property.key.value)
                    : null;
            if (name === null)
                continue;
            const key = `${objectKey}.${name}`;
            this.evaluateExpression(key, property.value, state);
            if (t.isObjectExpression(property.value)) {
                this.seedObjectProperties(key, property.value, state, depth + 1);
            }
        }
    }
    forgetDescendants(state, key) {
        const prefix = `${key}.`;
        for (const candidate of state.keys()) {
            if (candidate.startsWith(prefix))
                state.delete(candidate);
        }
    }
    /**
     * Abstract value of an expression used when combining operands (logical
     * expressions etc.): known literals keep their meaning, identifiers are
     * looked up, everything else is Top with propagated taint.
     */
    abstractValueOf(expr, state) {
        if (t.isNullLiteral(expr)) {
            return { nullability: 'Null', taint: domain_1.TaintDomain.CLEAN };
        }
        if (t.isIdentifier(expr) && expr.name === 'undefined') {
            return { nullability: 'Undefined', taint: domain_1.TaintDomain.CLEAN };
        }
        if (t.isIdentifier(expr)) {
            return domain_1.MemoryState.get(state, this.symbols.key(expr));
        }
        if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
            const key = this.symbols.keyForMember(expr);
            if (key && state.has(key))
                return domain_1.MemoryState.get(state, key);
            return { nullability: 'Top', taint: this.extractTaint(expr, state) };
        }
        if (t.isStringLiteral(expr) ||
            t.isNumericLiteral(expr) ||
            t.isBooleanLiteral(expr) ||
            t.isTemplateLiteral(expr) ||
            t.isObjectExpression(expr) ||
            t.isArrayExpression(expr)) {
            return { nullability: 'NonNull', taint: domain_1.TaintDomain.CLEAN };
        }
        return { nullability: 'Top', taint: this.extractTaint(expr, state) };
    }
    extractInterval(expr, state) {
        if (t.isNumericLiteral(expr)) {
            return domain_1.IntervalDomain.constant(expr.value);
        }
        if (t.isIdentifier(expr)) {
            return domain_1.MemoryState.get(state, this.symbols.key(expr)).interval;
        }
        return undefined;
    }
    extractTaint(expr, state, depth = 0) {
        if (!expr || depth > 8)
            return domain_1.TaintDomain.CLEAN;
        if (t.isIdentifier(expr)) {
            return domain_1.MemoryState.get(state, this.symbols.key(expr)).taint;
        }
        if (t.isTSAsExpression(expr) || t.isTSSatisfiesExpression(expr) ||
            t.isTSTypeAssertion(expr) || t.isTSNonNullExpression(expr) ||
            t.isParenthesizedExpression(expr)) {
            return this.extractTaint(expr.expression, state, depth + 1);
        }
        if (t.isTemplateLiteral(expr)) {
            return joinTaints(expr.expressions.map((item) => this.extractTaint(item, state, depth + 1)));
        }
        if (t.isBinaryExpression(expr) || t.isLogicalExpression(expr)) {
            return domain_1.TaintDomain.join(this.extractTaint(expr.left, state, depth + 1), this.extractTaint(expr.right, state, depth + 1));
        }
        if (t.isConditionalExpression(expr)) {
            return joinTaints([
                this.extractTaint(expr.consequent, state, depth + 1),
                this.extractTaint(expr.alternate, state, depth + 1),
            ]);
        }
        if (t.isArrayExpression(expr)) {
            return joinTaints(expr.elements.map((item) => item && !t.isSpreadElement(item)
                ? this.extractTaint(item, state, depth + 1)
                : item && t.isSpreadElement(item)
                    ? this.extractTaint(item.argument, state, depth + 1)
                    : domain_1.TaintDomain.CLEAN));
        }
        if (t.isObjectExpression(expr)) {
            return joinTaints(expr.properties.map((property) => {
                if (t.isObjectProperty(property))
                    return this.extractTaint(property.value, state, depth + 1);
                if (t.isSpreadElement(property))
                    return this.extractTaint(property.argument, state, depth + 1);
                return domain_1.TaintDomain.CLEAN;
            }));
        }
        if (t.isCallExpression(expr) || t.isMemberExpression(expr)) {
            const source = this.checkTaintSource(expr);
            if (source)
                return domain_1.TaintDomain.tainted(source);
            if (t.isCallExpression(expr) && isTransparentValueCall(expr)) {
                return joinTaints(expr.arguments.map((argument) => t.isExpression(argument) || t.isSpreadElement(argument)
                    ? this.extractTaint(t.isSpreadElement(argument) ? argument.argument : argument, state, depth + 1)
                    : domain_1.TaintDomain.CLEAN));
            }
            if (t.isMemberExpression(expr)) {
                const base = this.baseIdentifier(expr);
                if (base)
                    return domain_1.MemoryState.get(state, this.symbols.key(base)).taint;
            }
        }
        return domain_1.TaintDomain.CLEAN;
    }
    checkTaintSource(expr) {
        if (t.isCallExpression(expr)) {
            const callee = expr.callee;
            // Namespaced calls: AsyncStorage.getItem(), Linking.useURL(), ...
            if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && t.isIdentifier(callee.property)) {
                const callPath = `${callee.object.name}.${callee.property.name}`;
                if (callPath === 'AsyncStorage.getItem')
                    return 'AsyncStorage (Untrusted Client Storage)';
                if (callPath === 'Linking.useURL' || callPath === 'Linking.getInitialURL') {
                    return 'Expo Linking (Deep Link Input)';
                }
                return null;
            }
            // Bare hook calls from expo-router: useLocalSearchParams(), useURL()
            if (t.isIdentifier(callee) && (callee.name === 'useLocalSearchParams' || callee.name === 'useGlobalSearchParams')) {
                return 'Expo Router Params (Deep Link Input)';
            }
            return null;
        }
        if (t.isMemberExpression(expr) && t.isIdentifier(expr.property)) {
            // route.params / route.params.x / props.route.params — deep-link input
            const chain = this.memberChain(expr);
            if (chain[0] === 'route' || (chain.includes('route') && chain.includes('params'))) {
                return 'Navigation Params (Deep Link Input)';
            }
        }
        return null;
    }
    /**
     * Flattens a member-expression chain into names, root object first:
     * `route.params.untrustedHtml` -> ['route', 'params', 'untrustedHtml'].
     */
    memberChain(expr) {
        const names = [];
        let cur = expr;
        while (t.isMemberExpression(cur)) {
            if (t.isIdentifier(cur.property))
                names.unshift(cur.property.name);
            else
                names.unshift('<computed>');
            cur = cur.object;
        }
        if (t.isIdentifier(cur))
            names.unshift(cur.name);
        return names;
    }
    baseIdentifier(expr) {
        let cur = expr;
        while (t.isMemberExpression(cur))
            cur = cur.object;
        return t.isIdentifier(cur) ? cur : null;
    }
}
exports.AbstractInterpreter = AbstractInterpreter;
function joinTaints(values) {
    return values.reduce((joined, value) => domain_1.TaintDomain.join(joined, value), domain_1.TaintDomain.CLEAN);
}
function isTransparentValueCall(call) {
    if (t.isIdentifier(call.callee)) {
        return ['String', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent'].includes(call.callee.name);
    }
    return t.isMemberExpression(call.callee) && !call.callee.computed &&
        t.isIdentifier(call.callee.object, { name: 'JSON' }) &&
        t.isIdentifier(call.callee.property) &&
        ['stringify', 'parse'].includes(call.callee.property.name);
}
function summaryCalleeName(callee) {
    if (t.isIdentifier(callee))
        return callee.name;
    if (t.isMemberExpression(callee) && !callee.computed &&
        t.isIdentifier(callee.object) && t.isIdentifier(callee.property)) {
        return `${callee.object.name}.${callee.property.name}`;
    }
    return null;
}
