import * as t from '@babel/types';
import { MemoryAbstractState } from '../types/verifier';
import { SymbolTable } from './symbols';
/**
 * Path-sensitive refinement of abstract memory states along CFG edges.
 *
 * When the CFG builder labels an edge with the branch condition that guards
 * it, the fixpoint uses `refineState` to narrow the predecessor's outgoing
 * state before joining — e.g. the false edge of `if (user === null)` proves
 * `user` is non-null on that path, eliminating downstream false positives.
 */
export declare function refineState(state: MemoryAbstractState, test: t.Node | undefined | null, polarity: boolean, symbols?: SymbolTable): MemoryAbstractState;
export declare const NullabilityRefiner: {
    refineState: typeof refineState;
};
