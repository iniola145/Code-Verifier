import * as t from '@babel/types';
export declare class SymbolTable {
    private readonly keys;
    static fromAst(ast: t.File): SymbolTable;
    key(identifier: t.Identifier): string;
    /** Stable memory key for a statically named property chain. */
    keyForMember(member: t.MemberExpression | t.OptionalMemberExpression): string | null;
}
