"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryState = exports.TaintDomain = exports.NullabilityDomain = exports.IntervalDomain = void 0;
// ==========================================
// 1. Interval Domain Math ([min, max])
// ==========================================
class IntervalDomain {
    static TOP = { min: -Infinity, max: Infinity };
    static constant(val) {
        return { min: val, max: val };
    }
    static fromRange(min, max) {
        return { min, max };
    }
    static isBottom(a) {
        return a.min > a.max;
    }
    static isTop(a) {
        return a.min === -Infinity && a.max === Infinity;
    }
    static join(a, b) {
        if (this.isBottom(a))
            return b;
        if (this.isBottom(b))
            return a;
        return {
            min: Math.min(a.min, b.min),
            max: Math.max(a.max, b.max),
        };
    }
    static meet(a, b) {
        if (this.isBottom(a) || this.isBottom(b))
            return { min: 1, max: 0 };
        const min = Math.max(a.min, b.min);
        const max = Math.min(a.max, b.max);
        return { min, max };
    }
    /**
     * Widening operator: Prevents infinite ascending chains in loops.
     * If upper bound increased, jump to +Infinity.
     * If lower bound decreased, jump to -Infinity.
     */
    static widen(a, b) {
        if (this.isBottom(a))
            return b;
        if (this.isBottom(b))
            return a;
        return {
            min: b.min < a.min ? -Infinity : a.min,
            max: b.max > a.max ? Infinity : a.max,
        };
    }
    static add(a, b) {
        if (this.isBottom(a) || this.isBottom(b))
            return { min: 1, max: 0 };
        return this.sanitize({
            min: a.min + b.min,
            max: a.max + b.max,
        });
    }
    static subtract(a, b) {
        if (this.isBottom(a) || this.isBottom(b))
            return { min: 1, max: 0 };
        return this.sanitize({
            min: a.min - b.max,
            max: a.max - b.min,
        });
    }
    /**
     * Repairs intervals degraded by ±∞ arithmetic (e.g. [+∞] + [-∞] = NaN).
     */
    static sanitize(a) {
        if (Number.isNaN(a.min) || Number.isNaN(a.max))
            return this.TOP;
        return a;
    }
    static equals(a, b) {
        if (!a && !b)
            return true;
        if (!a || !b)
            return false;
        return a.min === b.min && a.max === b.max;
    }
    static toString(a) {
        if (!a)
            return 'unknown';
        if (this.isBottom(a))
            return '⊥ (empty)';
        const minStr = a.min === -Infinity ? '-∞' : a.min.toString();
        const maxStr = a.max === Infinity ? '+∞' : a.max.toString();
        return `[${minStr}, ${maxStr}]`;
    }
}
exports.IntervalDomain = IntervalDomain;
// ==========================================
// 2. Nullability Domain Lattice
// ==========================================
class NullabilityDomain {
    static join(a, b) {
        if (a === 'Bottom')
            return b;
        if (b === 'Bottom')
            return a;
        if (a === b)
            return a;
        if (a === 'Top' || b === 'Top')
            return 'Top';
        // Combining any nullable/null/undefined with NonNull yields Nullable
        return 'Nullable';
    }
    static meet(a, b) {
        if (a === 'Bottom' || b === 'Bottom')
            return 'Bottom';
        if (a === 'Top')
            return b;
        if (b === 'Top')
            return a;
        if (a === b)
            return a;
        return 'Bottom'; // e.g. NonNull meet Null = unreachable
    }
    static isPossiblyNullOrUndefined(val) {
        return val === 'Null' || val === 'Undefined' || val === 'Nullable' || val === 'Top';
    }
    /**
     * True when the lattice *knows* the value can be null/undefined.
     * Unlike isPossiblyNullOrUndefined, an unknown ('Top') value is NOT
     * reported — flagging every unmodeled expression (object literals, call
     * results, etc.) as a potential null deref produces unusable false
     * positives.
     */
    static isKnownPossiblyNull(val) {
        return val === 'Null' || val === 'Undefined' || val === 'Nullable';
    }
}
exports.NullabilityDomain = NullabilityDomain;
// ==========================================
// 3. Taint Domain Lattice
// ==========================================
class TaintDomain {
    static CLEAN = { isTainted: false, sources: [] };
    static tainted(source) {
        return { isTainted: true, sources: [source] };
    }
    static join(a, b) {
        if (!a.isTainted && !b.isTainted)
            return this.CLEAN;
        const sourcesSet = new Set([...a.sources, ...b.sources]);
        return {
            isTainted: true,
            sources: Array.from(sourcesSet),
        };
    }
    static equals(a, b) {
        if (a.isTainted !== b.isTainted)
            return false;
        if (a.sources.length !== b.sources.length)
            return false;
        return a.sources.every((s, i) => s === b.sources[i]);
    }
}
exports.TaintDomain = TaintDomain;
// ==========================================
// 4. Memory Abstract State Utilities
// ==========================================
class MemoryState {
    static clone(state) {
        const next = new Map();
        for (const [varName, val] of state.entries()) {
            next.set(varName, {
                interval: val.interval ? { ...val.interval } : undefined,
                nullability: val.nullability,
                taint: { isTainted: val.taint.isTainted, sources: [...val.taint.sources] },
            });
        }
        return next;
    }
    static defaultVarState() {
        return {
            nullability: 'Top',
            taint: TaintDomain.CLEAN,
        };
    }
    static get(state, varName) {
        const existing = state.get(varName);
        if (existing)
            return existing;
        return this.defaultVarState();
    }
    static set(state, varName, val) {
        const current = this.get(state, varName);
        state.set(varName, {
            interval: val.interval !== undefined ? val.interval : current.interval,
            nullability: val.nullability !== undefined ? val.nullability : current.nullability,
            taint: val.taint !== undefined ? val.taint : current.taint,
        });
    }
    /**
     * Joins two memory states. An EMPTY map is the identity (⊥): missing keys
     * mean "unknown/Top", so an empty accumulator must not pollute known
     * facts — join({}, {x: NonNull}) has to be {x: NonNull}, not {x: Top}.
     */
    static join(stateA, stateB) {
        if (stateA.size === 0)
            return MemoryState.clone(stateB);
        if (stateB.size === 0)
            return MemoryState.clone(stateA);
        const result = new Map();
        const allKeys = new Set([...stateA.keys(), ...stateB.keys()]);
        for (const key of allKeys) {
            const valA = stateA.get(key) || this.defaultVarState();
            const valB = stateB.get(key) || this.defaultVarState();
            const joinedInterval = valA.interval && valB.interval
                ? IntervalDomain.join(valA.interval, valB.interval)
                : valA.interval || valB.interval;
            const joinedNullability = NullabilityDomain.join(valA.nullability, valB.nullability);
            const joinedTaint = TaintDomain.join(valA.taint, valB.taint);
            result.set(key, {
                interval: joinedInterval,
                nullability: joinedNullability,
                taint: joinedTaint,
            });
        }
        return result;
    }
    static widen(stateA, stateB) {
        if (stateA.size === 0)
            return MemoryState.clone(stateB);
        if (stateB.size === 0)
            return MemoryState.clone(stateA);
        const result = new Map();
        const allKeys = new Set([...stateA.keys(), ...stateB.keys()]);
        for (const key of allKeys) {
            const valA = stateA.get(key) || this.defaultVarState();
            const valB = stateB.get(key) || this.defaultVarState();
            const widenedInterval = valA.interval && valB.interval
                ? IntervalDomain.widen(valA.interval, valB.interval)
                : valB.interval || valA.interval;
            const joinedNullability = NullabilityDomain.join(valA.nullability, valB.nullability);
            const joinedTaint = TaintDomain.join(valA.taint, valB.taint);
            result.set(key, {
                interval: widenedInterval,
                nullability: joinedNullability,
                taint: joinedTaint,
            });
        }
        return result;
    }
    static equals(stateA, stateB) {
        if (stateA.size !== stateB.size)
            return false;
        for (const [key, valA] of stateA.entries()) {
            const valB = stateB.get(key);
            if (!valB)
                return false;
            if (!IntervalDomain.equals(valA.interval, valB.interval))
                return false;
            if (valA.nullability !== valB.nullability)
                return false;
            if (!TaintDomain.equals(valA.taint, valB.taint))
                return false;
        }
        return true;
    }
}
exports.MemoryState = MemoryState;
