import traverse from '@babel/traverse';
import * as t from '@babel/types';

export class SymbolTable {
  private readonly keys = new WeakMap<t.Identifier, string>();

  static fromAst(ast: t.File): SymbolTable {
    const table = new SymbolTable();
    traverse(ast, {
      Identifier(path) {
        const binding = path.scope.getBinding(path.node.name);
        if (!binding) return;
        const anchor = binding.identifier.start ?? binding.identifier.loc?.start.index;
        table.keys.set(path.node, `${path.node.name}@${anchor ?? 'binding'}`);
      },
    });
    return table;
  }

  key(identifier: t.Identifier): string {
    return this.keys.get(identifier) ?? identifier.name;
  }

  /** Stable memory key for a statically named property chain. */
  keyForMember(member: t.MemberExpression | t.OptionalMemberExpression): string | null {
    const parts: string[] = [];
    let current: t.Expression = member;
    for (let depth = 0; depth < 8; depth++) {
      if (!t.isMemberExpression(current) && !t.isOptionalMemberExpression(current)) break;
      const property = staticPropertyName(current);
      if (property === null) return null;
      parts.unshift(property);
      current = current.object;
    }
    if (!t.isIdentifier(current)) return null;
    return [this.key(current), ...parts].join('.');
  }
}

function staticPropertyName(member: t.MemberExpression | t.OptionalMemberExpression): string | null {
  if (!member.computed && t.isIdentifier(member.property)) return member.property.name;
  if (member.computed && (t.isStringLiteral(member.property) || t.isNumericLiteral(member.property))) {
    return String(member.property.value);
  }
  return null;
}
