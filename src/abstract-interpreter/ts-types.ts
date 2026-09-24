import * as t from "@babel/types";
import { NullabilityValue } from "../types/verifier";

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
export function annotationNullability(
  typeAnnotation: t.Node | undefined | null,
): NullabilityValue | null {
  if (!typeAnnotation) return null;
  // TSTypeAnnotation wraps the actual type
  const ty = t.isTSTypeAnnotation(typeAnnotation)
    ? typeAnnotation.typeAnnotation
    : typeAnnotation;

  if (t.isTSNullKeyword(ty)) return "Null";
  if (t.isTSUndefinedKeyword(ty) || t.isTSVoidKeyword(ty)) return "Undefined";

  if (t.isTSUnionType(ty)) {
    const hasNull = ty.types.some((tt) => t.isTSNullKeyword(tt));
    const hasUndef = ty.types.some(
      (tt) => t.isTSUndefinedKeyword(tt) || t.isTSVoidKeyword(tt),
    );
    const hasUnknown = ty.types.some(
      (tt) => t.isTSAnyKeyword(tt) || t.isTSUnknownKeyword(tt),
    );
    // `Foo | null` -> Nullable; but `Foo | any` tells us nothing useful
    if (hasUnknown) return null;
    if (hasNull && hasUndef) return "Nullable";
    if (hasNull) return "Nullable";
    if (hasUndef) return "Undefined";
    // A union of concrete types (e.g. 'a' | 'b') is non-null
    return "NonNull";
  }

  if (t.isTSAnyKeyword(ty) || t.isTSUnknownKeyword(ty)) return null;

  // Concrete type (string, User, generic) — TS says it is present
  return "NonNull";
}

/**
 * Nullability seed for a function parameter from its type annotation.
 * Returns null for patterns we can't name (destructured, rest, untyped).
 */
export function paramNullabilitySeed(
  param: t.Node,
): { name: string; nullability: NullabilityValue } | null {
  let id: t.Identifier | null = null;
  if (t.isIdentifier(param)) {
    id = param;
  } else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
    id = param.left;
  }
  if (!id) return null;

  const nul = annotationNullability(id.typeAnnotation);
  // Only seed facts that CHANGE behavior: nullable seeds make the null rule
  // fire; NonNull seeds would suppress on untyped runtime reality, which is
  // too strong for parameters (TS types are not runtime checks).
  if (nul === "Nullable" || nul === "Null" || nul === "Undefined") {
    return { name: id.name, nullability: nul };
  }
  return null;
}
