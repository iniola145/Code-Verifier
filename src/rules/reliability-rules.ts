import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";

function emit(
  ctx: RuleContext,
  node: t.Node,
  ruleId: string,
  category: "CORRECTNESS" | "PERFORMANCE",
  severity: "HIGH" | "MEDIUM" | "LOW",
  message: string,
  explanation: string,
  remediation: string,
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    category,
    severity,
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

export const EmptyCatchRule: VerificationRule = {
  id: "REL-001",
  name: "Empty Catch Block",
  description: "Detects exceptions silently discarded by empty catch blocks.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CatchClause(path) {
        if (path.node.body.body.length > 0) return;
        const start = path.node.body.loc?.start.line ?? 1;
        const end = path.node.body.loc?.end.line ?? start;
        const bodyText = ctx.lines.slice(start - 1, end).join("\n");
        if (
          /\b(?:ignore(?:d)?|intentional(?:ly)?|best[- ]effort|graceful fallback|optional|handled by)\b/i.test(
            bodyText,
          )
        )
          return;
        emit(
          ctx,
          path.node,
          "REL-001",
          "CORRECTNESS",
          "MEDIUM",
          "An exception is silently discarded by an empty catch block.",
          "The operation can fail without telemetry, recovery, or propagation, leaving callers to continue with invalid assumptions.",
          "Handle the expected failure explicitly, add useful context and rethrow, or document a narrowly intentional ignore.",
        );
      },
    });
  },
};

export const FinallyControlFlowRule: VerificationRule = {
  id: "REL-002",
  name: "Control Flow in Finally",
  description:
    "Detects return, throw, break, or continue statements that override completion from try/catch.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    traverse(ctx.ast, {
      TryStatement(path) {
        const finalizer = path.get("finalizer");
        if (!finalizer.node) return;
        finalizer.traverse({
          Function(inner) {
            inner.skip();
          },
          "ReturnStatement|ThrowStatement|BreakStatement|ContinueStatement"(
            flowPath,
          ) {
            emit(
              ctx,
              flowPath.node,
              "REL-002",
              "CORRECTNESS",
              "HIGH",
              "Control flow in finally overrides the pending result or error.",
              "A completion from finally replaces a return value or exception produced by the try or catch block.",
              "Keep finally limited to cleanup; return or throw after the try statement instead.",
            );
          },
        });
      },
    });
  },
};

export const UnreachableStatementRule: VerificationRule = {
  id: "LOGIC-003",
  name: "Unreachable Statement",
  description:
    "Detects statements following unconditional control-flow termination in the same block.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      BlockStatement(path) {
        let terminated = false;
        for (const statement of path.node.body) {
          if (terminated && !t.isFunctionDeclaration(statement)) {
            emit(
              ctx,
              statement,
              "LOGIC-003",
              "CORRECTNESS",
              "MEDIUM",
              "This statement is unreachable.",
              "A preceding return, throw, break, or continue always transfers control away from this block.",
              "Remove the dead statement or correct the preceding control flow.",
            );
            break;
          }
          terminated =
            t.isReturnStatement(statement) ||
            t.isThrowStatement(statement) ||
            t.isBreakStatement(statement) ||
            t.isContinueStatement(statement);
        }
      },
    });
  },
};

export const IgnoredMapResultRule: VerificationRule = {
  id: "QUAL-001",
  name: "Ignored map Result",
  description: "Detects map calls used solely as expression statements.",
  category: "PERFORMANCE",
  defaultSeverity: "LOW",
  check(ctx) {
    traverse(ctx.ast, {
      ExpressionStatement(path) {
        const expression = path.node.expression;
        if (
          !t.isCallExpression(expression) ||
          !t.isMemberExpression(expression.callee) ||
          !t.isIdentifier(expression.callee.property, { name: "map" })
        )
          return;
        emit(
          ctx,
          expression,
          "QUAL-001",
          "PERFORMANCE",
          "LOW",
          "The array returned by map() is ignored.",
          "map allocates a new array for transformed values; ignoring it usually means forEach was intended or a result was accidentally dropped.",
          "Use forEach for side effects, or assign/return the transformed array.",
        );
      },
    });
  },
};

export const ReactTestAntiPatternRule: VerificationRule = {
  id: "TEST-001",
  name: "React Test Anti-Pattern",
  description:
    "Detects dangerous anti-patterns in React test files: monkey-patching private React internals (__CLIENT_INTERNALS), direct component invocation, or rigid child array traversal.",
  category: "CORRECTNESS",
  defaultSeverity: "HIGH",
  check(ctx) {
    const isTestFile = /\.(test|spec)\.[jt]sx?$/.test(ctx.filePath);

    traverse(ctx.ast, {
      MemberExpression(path) {
        const prop = path.node.property;
        let propName = "";
        if (!path.node.computed && t.isIdentifier(prop)) {
          propName = prop.name;
        } else if (path.node.computed && t.isStringLiteral(prop)) {
          propName = prop.value;
        }

        // 1. Check for React private internals (__CLIENT_INTERNALS, __SECRET_INTERNALS)
        if (
          propName.includes("__CLIENT_INTERNALS") ||
          propName.includes("__SECRET_INTERNALS")
        ) {
          emit(
            ctx,
            path.node,
            "TEST-001",
            "CORRECTNESS",
            "HIGH",
            `Accessing private React internals (${propName}) in tests is an architectural anti-pattern.`,
            "React internal symbols are private and change without warning across React versions. Mutating internal hook dispatchers (__CLIENT_INTERNALS) bypasses the real React scheduler and produces fragile tests that fail to detect real-world bugs.",
            "Use standard '@testing-library/react' or '@testing-library/react-native' with render(<Component />), or mock dependencies cleanly at the module boundary."
          );
        }

        // 2. Check for brittle child index traversal (e.g. section.props.children[2])
        if (
          isTestFile &&
          path.node.computed &&
          t.isNumericLiteral(prop) &&
          t.isMemberExpression(path.node.object) &&
          !path.node.object.computed &&
          t.isIdentifier(path.node.object.property, { name: "children" })
        ) {
          emit(
            ctx,
            path.node,
            "TEST-001",
            "CORRECTNESS",
            "MEDIUM",
            "Traversing React element trees via child array indices (e.g. children[2]) is brittle.",
            "Child array indexing breaks as soon as components wrap elements in Fragments or styling containers. It tests implementation details rather than user-facing behavior.",
            "Render with a DOM test environment and query by text, role, or testid (e.g. screen.getByRole('button') or screen.getByText(...))."
          );
        }
      },

      CallExpression(path) {
        if (!isTestFile) return;
        const callee = path.node.callee;
        if (!t.isIdentifier(callee)) return;
        const name = callee.name;

        // 3. Check for direct component invocation as a function
        if (
          /^[A-Z][a-zA-Z0-9]+Guard$|^[A-Z][a-zA-Z0-9]+Coordinator$|^[A-Z][a-zA-Z0-9]+Screen$|^[A-Z][a-zA-Z0-9]+Modal$/.test(name) ||
          /^[A-Z][a-zA-Z0-9]+(Component|Layout|Card)$/.test(name)
        ) {
          emit(
            ctx,
            path.node,
            "TEST-001",
            "CORRECTNESS",
            "MEDIUM",
            `React component '${name}' is invoked directly as a function instead of rendered as JSX.`,
            "Invoking React components as functions (e.g. AuthGuard()) bypasses React's reconciler, hooks lifecycle, and scheduler. Real bugs in hook dependencies, renders, or effects will be masked.",
            `Render '${name}' using standard JSX syntax (e.g. render(<${name} />)) inside an environment configured with @testing-library/react.`
          );
        }
      },
    });
  },
};

export const RELIABILITY_RULES: VerificationRule[] = [
  EmptyCatchRule,
  FinallyControlFlowRule,
  UnreachableStatementRule,
  IgnoredMapResultRule,
  ReactTestAntiPatternRule,
];
