import * as path from 'path';
import ts from 'typescript';
import { Diagnostic } from './types/verifier';

/** Project-wide TypeScript checker used for rules that cannot be soundly inferred from syntax alone. */
export class SemanticAnalysisIndex {
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;

  static fromFiles(files: string[]): SemanticAnalysisIndex {
    const roots = files.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    const program = ts.createProgram(roots, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
    });
    return new SemanticAnalysisIndex(program);
  }

  private constructor(program: ts.Program) {
    this.program = program;
    this.checker = program.getTypeChecker();
  }

  diagnosticsForFile(filePath: string): Diagnostic[] {
    const source = this.program.getSourceFile(path.resolve(filePath));
    if (!source || source.isDeclarationFile || /\.[cm]?jsx?$/.test(source.fileName)) return [];
    const diagnostics: Diagnostic[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node) && !ts.isVoidExpression(node.expression) &&
          this.isPromiseLike(node.expression) && !this.hasRejectionHandler(node.expression)) {
        // MEDIUM, not HIGH: fire-and-forget UI helpers (haptics, toasts,
        // analytics) are idiomatic and would otherwise drown real findings.
        diagnostics.push(this.makeDiagnostic(source, node.expression, 'TYPE-001', 'MEDIUM',
          'A Promise-returning expression is not awaited, returned, voided, or rejection-handled.',
          'The operation can continue after its caller and a rejection can become unhandled.',
          'Await or return the Promise, attach a rejection handler, or explicitly use void when fire-and-forget is intentional.'));
      }
      const condition = ts.isConditionalExpression(node) ? node.condition
        : ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : null;
      if (condition && this.isPromiseLike(condition)) {
        diagnostics.push(this.makeDiagnostic(source, condition, 'TYPE-002', 'HIGH',
          'A Promise is used directly as a boolean condition.',
          'Promise objects are always truthy, so this condition does not test the eventual boolean result.',
          'Await the Promise before evaluating its resolved value.'));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return diagnostics;
  }

  private isPromiseLike(node: ts.Expression): boolean {
    const type = this.checker.getTypeAtLocation(node);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    return type.isUnion()
      ? type.types.some((member) => this.isThenableType(member, node))
      : this.isThenableType(type, node);
  }

  private isThenableType(type: ts.Type, node: ts.Expression): boolean {
    const then = type.getProperty('then');
    if (!then) return false;
    return this.checker.getTypeOfSymbolAtLocation(then, node).getCallSignatures().length > 0;
  }

  private hasRejectionHandler(node: ts.Expression): boolean {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    const method = node.expression.name.text;
    return method === 'catch' || (method === 'then' && node.arguments.length >= 2);
  }

  private makeDiagnostic(source: ts.SourceFile, node: ts.Node, ruleId: string,
    severity: Diagnostic['severity'], message: string, explanation: string, remediation: string): Diagnostic {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source));
    const end = source.getLineAndCharacterOfPosition(node.getEnd());
    return {
      id: `${source.fileName}:${start.line + 1}:${start.character}:${ruleId}`,
      ruleId,
      category: 'CORRECTNESS',
      severity,
      message,
      explanation,
      filePath: source.fileName,
      loc: {
        start: { line: start.line + 1, column: start.character },
        end: { line: end.line + 1, column: end.character },
      },
      codeSnippet: source.text.slice(node.getStart(source), node.getEnd()),
      remediation: { summary: remediation, llmPromptHint: remediation },
    };
  }
}
