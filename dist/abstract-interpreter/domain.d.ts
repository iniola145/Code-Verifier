import { IntervalValue, NullabilityValue, TaintValue, VariableAbstractState, MemoryAbstractState } from '../types/verifier';
export declare class IntervalDomain {
    static TOP: IntervalValue;
    static constant(val: number): IntervalValue;
    static fromRange(min: number, max: number): IntervalValue;
    static isBottom(a: IntervalValue): boolean;
    static isTop(a: IntervalValue): boolean;
    static join(a: IntervalValue, b: IntervalValue): IntervalValue;
    static meet(a: IntervalValue, b: IntervalValue): IntervalValue;
    /**
     * Widening operator: Prevents infinite ascending chains in loops.
     * If upper bound increased, jump to +Infinity.
     * If lower bound decreased, jump to -Infinity.
     */
    static widen(a: IntervalValue, b: IntervalValue): IntervalValue;
    static add(a: IntervalValue, b: IntervalValue): IntervalValue;
    static subtract(a: IntervalValue, b: IntervalValue): IntervalValue;
    /**
     * Repairs intervals degraded by ±∞ arithmetic (e.g. [+∞] + [-∞] = NaN).
     */
    static sanitize(a: IntervalValue): IntervalValue;
    static equals(a?: IntervalValue, b?: IntervalValue): boolean;
    static toString(a?: IntervalValue): string;
}
export declare class NullabilityDomain {
    static join(a: NullabilityValue, b: NullabilityValue): NullabilityValue;
    static meet(a: NullabilityValue, b: NullabilityValue): NullabilityValue;
    static isPossiblyNullOrUndefined(val: NullabilityValue): boolean;
    /**
     * True when the lattice *knows* the value can be null/undefined.
     * Unlike isPossiblyNullOrUndefined, an unknown ('Top') value is NOT
     * reported — flagging every unmodeled expression (object literals, call
     * results, etc.) as a potential null deref produces unusable false
     * positives.
     */
    static isKnownPossiblyNull(val: NullabilityValue): boolean;
}
export declare class TaintDomain {
    static CLEAN: TaintValue;
    static tainted(source: string): TaintValue;
    static join(a: TaintValue, b: TaintValue): TaintValue;
    static equals(a: TaintValue, b: TaintValue): boolean;
}
export declare class MemoryState {
    static clone(state: MemoryAbstractState): MemoryAbstractState;
    static defaultVarState(): VariableAbstractState;
    static get(state: MemoryAbstractState, varName: string): VariableAbstractState;
    static set(state: MemoryAbstractState, varName: string, val: Partial<VariableAbstractState>): void;
    /**
     * Joins two memory states. An EMPTY map is the identity (⊥): missing keys
     * mean "unknown/Top", so an empty accumulator must not pollute known
     * facts — join({}, {x: NonNull}) has to be {x: NonNull}, not {x: Top}.
     */
    static join(stateA: MemoryAbstractState, stateB: MemoryAbstractState): MemoryAbstractState;
    static widen(stateA: MemoryAbstractState, stateB: MemoryAbstractState): MemoryAbstractState;
    static equals(stateA: MemoryAbstractState, stateB: MemoryAbstractState): boolean;
}
