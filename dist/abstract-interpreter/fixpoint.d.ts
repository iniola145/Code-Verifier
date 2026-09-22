import { CFG, MemoryAbstractState } from '../types/verifier';
import { FunctionSummary } from './function-summaries';
import { SymbolTable } from './symbols';
export declare class AbstractInterpreter {
    private readonly functionSummaries;
    private readonly symbols;
    constructor(functionSummaries?: Map<string, FunctionSummary>, symbols?: SymbolTable);
    /**
     * Runs the worklist fixed-point algorithm on a Control Flow Graph.
     * Terminates via widening; `cfg.truncated` is set if the safety cap bit.
     */
    analyze(cfg: CFG, initialState?: MemoryAbstractState): void;
    /**
     * Transfer function executing statements sequentially on abstract memory state.
     */
    private transfer;
    private transferStatement;
    private transferExpressionStatement;
    /**
     * TS annotation upgrade for `const u: User | null = api.user`.
     * Fills gaps only: a computed NonNull/Null fact is more precise than the
     * annotation and wins; 'Top' (unmodeled) is upgraded to the annotation.
     * Taint/interval survive via the partial-merge in MemoryState.set.
     */
    private upgradeFromAnnotation;
    /**
     * `const [value, setValue] = useState(...)` — the dominant React pattern.
     * The value element gets the nullability of the initializer (or the type
     * argument for `useState<T | null>(x)`); the setter is a function (NonNull).
     */
    private transferDestructuring;
    /**
     * Conservatively propagates the source value to identifiers introduced by
     * object/array destructuring. A selected property has unknown nullability,
     * but it retains taint from the container (route params, storage, etc.).
     */
    private propagatePatternValue;
    private evaluateExpression;
    private seedObjectProperties;
    private forgetDescendants;
    /**
     * Abstract value of an expression used when combining operands (logical
     * expressions etc.): known literals keep their meaning, identifiers are
     * looked up, everything else is Top with propagated taint.
     */
    private abstractValueOf;
    private extractInterval;
    private extractTaint;
    private checkTaintSource;
    /**
     * Flattens a member-expression chain into names, root object first:
     * `route.params.untrustedHtml` -> ['route', 'params', 'untrustedHtml'].
     */
    private memberChain;
    private baseIdentifier;
}
