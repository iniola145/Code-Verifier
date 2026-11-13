import * as path from "path";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";
import { classesFromDomCall } from "../project-ui-index";

function emit(
  ctx: RuleContext,
  node: t.Node,
  ruleId: string,
  message: string,
  explanation: string,
  remediation: string,
  severity: "MEDIUM" | "LOW" = "MEDIUM",
): void {
  const loc = nodeToLocation(node);
  ctx.report({
    id: `${ctx.filePath}:${loc.start.line}:${loc.start.column}:${ruleId}`,
    ruleId,
    category: "CORRECTNESS",
    severity,
    message,
    explanation,
    loc,
    codeSnippet: extractCodeSnippet(ctx.lines, loc),
    remediation: { summary: remediation, llmPromptHint: remediation },
  });
}

function schemaBackedState(
  ctx: RuleContext,
): Map<string, { schemaName: string; requiredFields: string[] }> {
  const result = new Map<
    string,
    { schemaName: string; requiredFields: string[] }
  >();
  traverse(ctx.ast, {
    VariableDeclarator(path) {
      if (
        !t.isArrayPattern(path.node.id) ||
        !t.isIdentifier(path.node.id.elements[0]) ||
        !t.isCallExpression(path.node.init)
      )
        return;
      const callee = path.node.init.callee;
      if (!(
        t.isIdentifier(callee, { name: "useState" }) ||
        (t.isMemberExpression(callee) &&
          t.isIdentifier(callee.property, { name: "useState" }))
      ))
        return;
      const type = path.node.init.typeParameters;
      if (
        !t.isTSTypeParameterInstantiation(type) ||
        !t.isTSTypeReference(type.params[0]) ||
        !t.isIdentifier(type.params[0].typeName)
      )
        return;
      const fact = ctx.projectSchemaTypes.get(type.params[0].typeName.name);
      if (fact) result.set(path.node.id.elements[0].name, fact);
    },
  });
  return result;
}

function functionName(path: NodePath<t.Function>): string {
  if (t.isFunctionDeclaration(path.node) && path.node.id)
    return path.node.id.name;
  if (
    path.parentPath.isVariableDeclarator() &&
    t.isIdentifier(path.parentPath.node.id)
  )
    return path.parentPath.node.id.name;
  return "";
}

function callbackIsExplicitlySynchronous(
  ctx: RuleContext,
  name: string,
): boolean {
  let synchronous = false;
  const isVoidFunction = (node: t.TSType | null | undefined): boolean =>
    !!node &&
    t.isTSFunctionType(node) &&
    !!node.typeAnnotation &&
    t.isTSVoidKeyword(node.typeAnnotation.typeAnnotation);
  traverse(ctx.ast, {
    TSPropertySignature(path) {
      const key = path.node.key;
      if (
        (t.isIdentifier(key, { name }) ||
          t.isStringLiteral(key, { value: name })) &&
        isVoidFunction(path.node.typeAnnotation?.typeAnnotation)
      )
        synchronous = true;
    },
    TSMethodSignature(path) {
      const key = path.node.key;
      if (
        (t.isIdentifier(key, { name }) ||
          t.isStringLiteral(key, { value: name })) &&
        path.node.typeAnnotation &&
        t.isTSVoidKeyword(path.node.typeAnnotation.typeAnnotation)
      )
        synchronous = true;
    },
  });
  return synchronous;
}

export const MissingFormSchemaValidationRule: VerificationRule = {
  id: "FORM-001",
  name: "Schema-Backed Form Submitted Without Validation",
  description:
    "Detects schema-derived form state submitted without parse or safeParse.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    const states = schemaBackedState(ctx);
    if (states.size === 0) return;
    traverse(ctx.ast, {
      Function(path) {
        const name = functionName(path);
        if (!/(?:save|submit|create|update|apply|confirm)/i.test(name)) return;
        const text = path.toString();
        for (const [state, fact] of states) {
          if (
            !new RegExp(
              `\\b(?:onCreate|onUpdate|onSave|onSubmit|mutate|mutateAsync)\\s*\\([^)]*\\b${state}\\b`,
            ).test(text)
          )
            continue;
          if (
            new RegExp(
              `\\b${fact.schemaName}\\s*\\.\\s*(?:parse|safeParse)\\s*\\(\\s*${state}\\b`,
            ).test(text) ||
            /\.(?:parse|safeParse)\s*\(/.test(text)
          )
            continue;
          emit(
            ctx,
            path.node,
            "FORM-001",
            `Schema-backed form '${state}' is submitted without runtime validation.`,
            `Its TypeScript type came from ${fact.schemaName}, but types disappear at runtime and do not enforce required fields or refinements.`,
            `Import ${fact.schemaName}, validate ${state} with safeParse, stop on failure, and submit parsed data on success.`,
          );
        }
      },
    });
  },
};

export const PartialFormValidationRule: VerificationRule = {
  id: "FORM-002",
  name: "Partial Validation Bypasses Form Schema",
  description:
    "Detects manual submit guards that cover only some schema-required fields.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    const states = schemaBackedState(ctx);
    traverse(ctx.ast, {
      Function(path) {
        if (
          !/(?:save|submit|create|update|apply|confirm)/i.test(
            functionName(path),
          )
        )
          return;
        const text = path.toString();
        for (const [state, fact] of states) {
          if (
            !new RegExp(`\\b${state}\\.`).test(text) ||
            /\.(?:parse|safeParse)\s*\(/.test(text)
          )
            continue;
          const checked = fact.requiredFields.filter((field) =>
            new RegExp(`\\b${state}\\.${field}\\b`).test(text),
          );
          const missing = fact.requiredFields.filter(
            (field) => !checked.includes(field),
          );
          if (checked.length === 0 || missing.length === 0) continue;
          emit(
            ctx,
            path.node,
            "FORM-002",
            `Manual form guard omits required schema field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
            "A partial hand-written check can drift from the declared schema and allow invalid records through.",
            "Validate the complete value with the schema instead of duplicating individual required-field checks.",
          );
        }
      },
    });
  },
};

export const SilentFormFailureRule: VerificationRule = {
  id: "FORM-003",
  name: "Silent Form Validation Failure",
  description:
    "Detects submit handlers that return on invalid input without visible feedback.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      Function(path) {
        if (
          !/(?:save|submit|create|update|apply|confirm)/i.test(
            functionName(path),
          )
        )
          return;
        path.traverse({
          IfStatement(inner) {
            if (inner.getFunctionParent() !== path) return;
            const consequent = inner.node.consequent;
            const silentlyReturns =
              t.isReturnStatement(consequent) ||
              (t.isBlockStatement(consequent) &&
                consequent.body.length === 1 &&
                t.isReturnStatement(consequent.body[0]));
            if (!silentlyReturns) return;
            const test = inner.get("test").toString();
            if (
              !/(?:trim|length|safeParse|isValid|errors?|required)/i.test(test)
            )
              return;
            // Re-entrancy / in-flight submission guards (e.g. `if (isSubmittingRef.current || isSubmitting || items.length === 0) return;`)
            // prevent duplicate submits or empty-state calls rather than silently failing field validation.
            if (
              /\b(?:isSubmitting(?:Ref)?|submitting|isLoading|isPending|isMutating|inFlight)\b/i.test(
                test,
              )
            )
              return;
            const identifiers = new Set<string>();
            inner.get("test").traverse({
              Identifier(identifier) {
                if (identifier.isReferencedIdentifier())
                  identifiers.add(identifier.node.name);
              },
            });
            const componentText = path.getFunctionParent()?.toString() ?? "";
            if (
              [...identifiers].some((identifier) =>
                new RegExp(`disabled\\s*=\\s*\\{[^}]*\\b${identifier}\\b`).test(
                  componentText,
                ),
              )
            )
              return;
            const body = path.toString();
            if (
              /(?:setErrors?|toast\.|alert\s*\(|setFieldError|focus\s*\()/i.test(
                body.slice(
                  0,
                  body.indexOf(inner.toString()) + inner.toString().length,
                ),
              )
            )
              return;
            emit(
              ctx,
              inner.node,
              "FORM-003",
              "Invalid form input returns silently without user feedback.",
              "The user receives no explanation, field highlight, or focus target and may interpret the button as broken.",
              "Store field errors and render them, or show an accessible toast/alert and focus the first invalid field.",
            );
          },
        });
      },
    });
  },
};

export const MissingFormErrorPropagationRule: VerificationRule = {
  id: "FORM-004",
  name: "Form Errors Not Propagated to Fields",
  description:
    "Detects schema-backed form editors rendered without an error channel.",
  category: "CORRECTNESS",
  defaultSeverity: "LOW",
  check(ctx) {
    const states = schemaBackedState(ctx);
    if (states.size === 0) return;
    traverse(ctx.ast, {
      JSXOpeningElement(path) {
        if (
          !t.isJSXIdentifier(path.node.name) ||
          !/(?:Form|Edit|Fields|Details)\w*(?:Tab|Panel|Form)?$/.test(
            path.node.name.name,
          )
        )
          return;
        const attributes = path.node.attributes.filter(t.isJSXAttribute);
        const passesState = attributes.some(
          (attribute) =>
            t.isJSXIdentifier(attribute.name) &&
            /(?:formData|values|data)/i.test(attribute.name.name) &&
            t.isJSXExpressionContainer(attribute.value) &&
            t.isIdentifier(attribute.value.expression) &&
            states.has(attribute.value.expression.name),
        );
        if (!passesState) return;
        if (
          attributes.some(
            (attribute) =>
              t.isJSXIdentifier(attribute.name) &&
              /error|invalid|touched/i.test(attribute.name.name),
          )
        )
          return;
        emit(
          ctx,
          path.node,
          "FORM-004",
          `${path.node.name.name} receives form data but no errors or invalid-state prop.`,
          "Even when submission validation fails, individual inputs have no channel for accessible field-level feedback.",
          "Pass mapped field errors/touched state and render messages with aria-invalid and aria-describedby.",
          "LOW",
        );
      },
    });
  },
};

export const PrematureFormCloseRule: VerificationRule = {
  id: "FORM-005",
  name: "Form Closes Before Submission Is Confirmed",
  description:
    "Detects save handlers that close UI immediately after an unawaited submission callback.",
  category: "CORRECTNESS",
  defaultSeverity: "LOW",
  check(ctx) {
    traverse(ctx.ast, {
      Function(path) {
        if (
          !/(?:save|submit|create|update|apply|confirm)/i.test(
            functionName(path),
          )
        )
          return;
        const calls: Array<{ name: string; path: NodePath<t.CallExpression> }> =
          [];
        path.traverse({
          CallExpression(call) {
            if (
              call.getFunctionParent() === path &&
              t.isIdentifier(call.node.callee)
            )
              calls.push({ name: call.node.callee.name, path: call });
          },
        });
        const submit = calls.find((call) =>
          /^(?:onCreate|onUpdate|onSave|onSubmit|mutateAsync?)$/.test(
            call.name,
          ),
        );
        const close = calls.find(
          (call) =>
            /^(?:onClose|closeModal|dismiss)$/.test(call.name) &&
            (call.path.node.start ?? 0) > (submit?.path.node.end ?? Infinity),
        );
        if (
          !submit ||
          !close ||
          submit.path.parentPath.isAwaitExpression() ||
          submit.path.parentPath.isReturnStatement()
        )
          return;
        if (callbackIsExplicitlySynchronous(ctx, submit.name)) return;
        emit(
          ctx,
          close.path.node,
          "FORM-005",
          "Form closes immediately after an unawaited submission callback.",
          "If persistence fails or validation is rejected downstream, user input disappears and the UI can falsely imply success.",
          "Await a success result before closing, or let the mutation success callback own dismissal.",
          "LOW",
        );
      },
    });
  },
};

function styleFacts(ctx: RuleContext) {
  const local =
    ctx.projectUiIndex?.definedStyleObjectsForFile(ctx.filePath) ?? new Map();
  return new Map([...local, ...ctx.projectStyleObjects]);
}

function filterDomClassUsage(node: t.CallExpression, names: string[]): string[] {
  const callee = node.callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.property) ||
    !t.isMemberExpression(callee.object) ||
    !t.isIdentifier(callee.object.property, { name: "classList" })
  )
    return names;
  const method = callee.property.name;
  // Removing a class never requires a CSS definition in the bundle.
  if (method === "remove") return [];
  if (method === "add" || method === "toggle") {
    const target = callee.object.object;
    const isRootTarget =
      (t.isIdentifier(target) &&
        /^(?:root|html|body|doc|documentElement)$/i.test(target.name)) ||
      (t.isMemberExpression(target) &&
        t.isIdentifier(target.property) &&
        ["documentElement", "body"].includes(target.property.name));
    if (isRootTarget)
      return names.filter((name) => name !== "light" && name !== "dark");
  }
  return names;
}

export const UndefinedStyleNameRule: VerificationRule = {
  id: "STYLE-001",
  name: "Undefined Style Name",
  description:
    "Detects missing keys on imported/local style objects and static CSS classes with no definition.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(ctx.filePath)) return;
    const facts = styleFacts(ctx);
    const cssClasses =
      ctx.projectUiIndex?.cssClassesForFile(ctx.filePath) ?? new Set<string>();
    const reportMissingClasses = (node: t.Node, names: string[]): void => {
      for (const name of names) {
        if (/[:/[\]{}]/.test(name) || cssClasses.has(name)) continue;
        emit(
          ctx,
          node,
          "STYLE-001",
          `CSS class '${name}' is used but no local definition was found.`,
          "A misspelled or deleted selector silently removes the intended styling.",
          `Define '.${name}' in project CSS or correct/remove the class reference.`,
          "LOW",
        );
      }
    };
    traverse(ctx.ast, {
      MemberExpression(path) {
        if (!t.isIdentifier(path.node.object)) return;
        const binding = path.scope.getBinding(path.node.object.name);
        if (binding && binding.scope.block.type !== "Program") return;
        const fact = facts.get(path.node.object.name);
        if (!fact) return;
        const key =
          !path.node.computed && t.isIdentifier(path.node.property)
            ? path.node.property.name
            : path.node.computed && t.isStringLiteral(path.node.property)
              ? path.node.property.value
              : null;
        if (key && !fact.keys.includes(key))
          emit(
            ctx,
            path.node,
            "STYLE-001",
            `Style '${path.node.object.name}.${key}' is used but never defined.`,
            "The element silently renders without the intended visual state, spacing, or layout.",
            `Define '${key}' in the style object/module or correct the reference.`,
          );
      },
      JSXAttribute(path) {
        if (
          cssClasses.size === 0 ||
          !t.isJSXIdentifier(path.node.name, { name: "className" }) ||
          !t.isStringLiteral(path.node.value)
        )
          return;
        if (
          path.parentPath.isJSXOpeningElement() &&
          path.parentPath.node.attributes.some(
            (attribute) =>
              t.isJSXAttribute(attribute) &&
              t.isJSXIdentifier(attribute.name, { name: "style" }),
          )
        )
          return;
        reportMissingClasses(
          path.node,
          path.node.value.value.split(/\s+/).filter(Boolean),
        );
      },
      CallExpression(path) {
        if (cssClasses.size === 0) return;
        const usage = classesFromDomCall(path.node);
        if (!usage || usage === "dynamic") return;
        const filtered = filterDomClassUsage(path.node, usage);
        if (filtered.length > 0) reportMissingClasses(path.node, filtered);
      },
      AssignmentExpression(path) {
        if (
          cssClasses.size === 0 ||
          !t.isMemberExpression(path.node.left) ||
          !t.isIdentifier(path.node.left.property, { name: "className" }) ||
          !t.isStringLiteral(path.node.right)
        )
          return;
        reportMissingClasses(
          path.node,
          path.node.right.value.split(/\s+/).filter(Boolean),
        );
      },
    });
  },
};

export const UnusedStyleNameRule: VerificationRule = {
  id: "STYLE-002",
  name: "Unused Style Definition",
  description:
    "Detects style-object and CSS-module class definitions unused across analyzed source files.",
  category: "CORRECTNESS",
  defaultSeverity: "LOW",
  check(ctx) {
    const local =
      ctx.projectUiIndex?.definedStyleObjectsForFile(ctx.filePath) ?? new Map();
    for (const [name, fact] of local)
      for (const key of fact.keys) {
        if (fact.usedKeys.has(key)) continue;
        let anchor: t.Node = ctx.ast.program;
        traverse(ctx.ast, {
          ObjectProperty(path) {
            if (
              t.isIdentifier(path.node.key, { name: key }) ||
              t.isStringLiteral(path.node.key, { value: key })
            )
              anchor = path.node;
          },
        });
        emit(
          ctx,
          anchor,
          "STYLE-002",
          `Style '${name}.${key}' is defined but never used.`,
          "Dead style definitions increase review cost and can hide obsolete UI variants.",
          `Remove '${key}' or use it from the intended component.`,
          "LOW",
        );
      }
    for (const item of ctx.projectUiIndex?.unusedCssClassesForFile(
      ctx.filePath,
    ) ?? [])
      emit(
        ctx,
        ctx.ast.program,
        "STYLE-002",
        `CSS class '.${item.className}' is defined but never used.`,
        "Dead selectors make stylesheet behavior harder to audit.",
        `Remove '.${item.className}' or reference it from the intended component.`,
        "LOW",
      );
  },
};

export const FORM_STYLE_RULES: VerificationRule[] = [
  MissingFormSchemaValidationRule,
  PartialFormValidationRule,
  SilentFormFailureRule,
  MissingFormErrorPropagationRule,
  PrematureFormCloseRule,
  UndefinedStyleNameRule,
  UnusedStyleNameRule,
];
