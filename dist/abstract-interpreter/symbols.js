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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymbolTable = void 0;
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
class SymbolTable {
    keys = new WeakMap();
    static fromAst(ast) {
        const table = new SymbolTable();
        (0, traverse_1.default)(ast, {
            Identifier(path) {
                const binding = path.scope.getBinding(path.node.name);
                if (!binding)
                    return;
                const anchor = binding.identifier.start ?? binding.identifier.loc?.start.index;
                table.keys.set(path.node, `${path.node.name}@${anchor ?? 'binding'}`);
            },
        });
        return table;
    }
    key(identifier) {
        return this.keys.get(identifier) ?? identifier.name;
    }
    /** Stable memory key for a statically named property chain. */
    keyForMember(member) {
        const parts = [];
        let current = member;
        for (let depth = 0; depth < 8; depth++) {
            if (!t.isMemberExpression(current) && !t.isOptionalMemberExpression(current))
                break;
            const property = staticPropertyName(current);
            if (property === null)
                return null;
            parts.unshift(property);
            current = current.object;
        }
        if (!t.isIdentifier(current))
            return null;
        return [this.key(current), ...parts].join('.');
    }
}
exports.SymbolTable = SymbolTable;
function staticPropertyName(member) {
    if (!member.computed && t.isIdentifier(member.property))
        return member.property.name;
    if (member.computed && (t.isStringLiteral(member.property) || t.isNumericLiteral(member.property))) {
        return String(member.property.value);
    }
    return null;
}
