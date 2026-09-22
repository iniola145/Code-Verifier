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
exports.annotationNullability = annotationNullability;
exports.paramNullabilitySeed = paramNullabilitySeed;
const t = __importStar(require("@babel/types"));
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
function annotationNullability(typeAnnotation) {
    if (!typeAnnotation)
        return null;
    // TSTypeAnnotation wraps the actual type
    const ty = t.isTSTypeAnnotation(typeAnnotation) ? typeAnnotation.typeAnnotation : typeAnnotation;
    if (t.isTSNullKeyword(ty))
        return 'Null';
    if (t.isTSUndefinedKeyword(ty) || t.isTSVoidKeyword(ty))
        return 'Undefined';
    if (t.isTSUnionType(ty)) {
        const hasNull = ty.types.some((tt) => t.isTSNullKeyword(tt));
        const hasUndef = ty.types.some((tt) => t.isTSUndefinedKeyword(tt) || t.isTSVoidKeyword(tt));
        const hasUnknown = ty.types.some((tt) => t.isTSAnyKeyword(tt) || t.isTSUnknownKeyword(tt));
        // `Foo | null` -> Nullable; but `Foo | any` tells us nothing useful
        if (hasUnknown)
            return null;
        if (hasNull && hasUndef)
            return 'Nullable';
        if (hasNull)
            return 'Nullable';
        if (hasUndef)
            return 'Undefined';
        // A union of concrete types (e.g. 'a' | 'b') is non-null
        return 'NonNull';
    }
    if (t.isTSAnyKeyword(ty) || t.isTSUnknownKeyword(ty))
        return null;
    // Concrete type (string, User, generic) — TS says it is present
    return 'NonNull';
}
/**
 * Nullability seed for a function parameter from its type annotation.
 * Returns null for patterns we can't name (destructured, rest, untyped).
 */
function paramNullabilitySeed(param) {
    let id = null;
    if (t.isIdentifier(param)) {
        id = param;
    }
    else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
        id = param.left;
    }
    if (!id)
        return null;
    const nul = annotationNullability(id.typeAnnotation);
    // Only seed facts that CHANGE behavior: nullable seeds make the null rule
    // fire; NonNull seeds would suppress on untyped runtime reality, which is
    // too strong for parameters (TS types are not runtime checks).
    if (nul === 'Nullable' || nul === 'Null' || nul === 'Undefined') {
        return { name: id.name, nullability: nul };
    }
    return null;
}
