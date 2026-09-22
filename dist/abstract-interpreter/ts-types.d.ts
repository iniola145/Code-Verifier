import * as t from '@babel/types';
import { NullabilityValue } from '../types/verifier';
/**
 * Extracts nullability facts from TypeScript type annotations.
 *
 * Only annotations that VISIBLY mention null/undefined are treated as
 * nullable — `any`/`unknown` return null (unknown) so we never flag on a
 * vague type. This is what makes the null-dereference rule useful on real
 * TypeScript codebases:
 *
 *   const u: User | null = api.user;   // seeded Nullable -> deref flagged
 *   function f(u: User | null) {...}   // param seeded Nullable at entry
 *   const x: string = anything();      // NonNull -> never flagged
 */
export declare function annotationNullability(typeAnnotation: t.Node | undefined | null): NullabilityValue | null;
/**
 * Nullability seed for a function parameter from its type annotation.
 * Returns null for patterns we can't name (destructured, rest, untyped).
 */
export declare function paramNullabilitySeed(param: t.Node): {
    name: string;
    nullability: NullabilityValue;
} | null;
