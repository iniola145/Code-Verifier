import { RuleContext, VerificationRule } from '../types/verifier';
export declare const AsyncEffectRule: VerificationRule;
export declare const ArrayIndexKeyRule: VerificationRule;
export declare const StaleTimerStateRule: VerificationRule;
export declare const FlatListIndexKeyRule: VerificationRule;
export declare const MixedNativeDriverRule: VerificationRule;
export declare const AnimationLatchStuckRule: VerificationRule;
export declare const PanResponderCaptureRule: VerificationRule;
export declare const RefAccessDuringRenderRule: VerificationRule;
export declare const UnusedStateRule: VerificationRule;
/** All JSX tag and attribute-identifier names in the file, used as a conservative "may be referenced" set. */
export declare function collectJsxIdentifierNames(ctx: RuleContext): Set<string>;
export declare const REACT_CORRECTNESS_RULES: VerificationRule[];
