import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { extractCodeSnippet, nodeToLocation } from "../parser/ast";
import { RuleContext, VerificationRule } from "../types/verifier";

function report(
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

function propertyOf(
  object: t.ObjectExpression,
  name: string,
): t.ObjectProperty | null {
  for (const property of object.properties) {
    if (!t.isObjectProperty(property)) continue;
    if (
      t.isIdentifier(property.key, { name }) ||
      t.isStringLiteral(property.key, { value: name })
    )
      return property;
  }
  return null;
}

function referencedNames(path: NodePath<any>): Set<string> {
  const names = new Set<string>();
  if (path.isIdentifier() && path.isReferencedIdentifier())
    names.add(path.node.name);
  path.traverse({
    Identifier(inner) {
      if (inner.isReferencedIdentifier()) names.add(inner.node.name);
    },
  });
  return names;
}

/**
 * Names computed from keyed inputs. A candidate counts as derived when it
 * appears in the initializer of a keyed identifier — transitively, bounded
 * depth — meaning the query key already depends on the data the candidate is
 * built from (e.g. key contains `generationId` where
 * `const generationId = offlineDetails?.catalogueGenerationId`).
 */
function derivedNamesFor(keyedNames: Set<string>, scopePath: NodePath): Set<string> {
  const derived = new Set<string>();
  for (const keyedName of keyedNames) {
    const binding = scopePath.scope.getBinding(keyedName);
    if (binding?.path.isVariableDeclarator())
      collectDerivedNames(binding.path, derived, new Set([keyedName]), 3);
  }
  return derived;
}

function collectDerivedNames(
  declarator: NodePath<t.VariableDeclarator>,
  derived: Set<string>,
  visiting: Set<string>,
  depth: number,
): void {
  if (depth <= 0 || !declarator.node.init) return;
  for (const name of referencedNames(declarator.get("init"))) {
    if (visiting.has(name)) continue;
    visiting.add(name);
    derived.add(name);
    if (depth > 1) {
      const nested = declarator.scope.getBinding(name);
      if (nested?.path.isVariableDeclarator())
        collectDerivedNames(nested.path, derived, visiting, depth - 1);
    }
  }
}

/**
 * Checks whether an un-keyed candidate object passed whole into queryFn has multiple
 * distinct properties projected into outer scope variables that feed into the query key.
 * When a function accepts `params` and projects several properties (`params?.status`,
 * `params?.search`, `params?.page`, `params?.limit`) into the query key builder,
 * passing `params` to `queryFn: () => service.get(params)` is covered.
 */
function isCoveredObjectInput(
  name: string,
  fnValue: NodePath<t.Function>,
  derived: Set<string>,
  references: NodePath<t.Identifier>[],
): boolean {
  const binding = fnValue.scope.getBinding(name);
  if (!binding) return false;
  if (!derived.has(name)) return false;

  const allRefs = binding.referencePaths;
  const outerRefs = allRefs.filter(
    (ref) => !ref.findParent((p) => p === fnValue),
  );

  const distinctProperties = new Set<string>();
  for (const ref of outerRefs) {
    if (!ref.isIdentifier()) return false;
    const parent = ref.parentPath?.node;
    if (
      (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
      parent.object === ref.node &&
      t.isIdentifier(parent.property)
    ) {
      distinctProperties.add(parent.property.name);
    } else if (!isProjectionUse(ref)) {
      return false;
    }
  }

  // Require at least 2 distinct properties projected into the key to avoid false clean
  // on a single field extraction where other fields are left unkeyed.
  if (distinctProperties.size < 2) return false;

  return references.every((ref) => {
    const parent = ref.parentPath?.node;
    return (
      (t.isCallExpression(parent) && parent.arguments.includes(ref.node)) ||
      isProjectionUse(ref)
    );
  });
}

/**
 * True when a use of an identifier only projects it: a normal or optional
 * member read off the identifier, or a null guard (`!v`, `v === null`,
 * `v ?? fallback`, `Boolean(v)`). Projected member values are already shaped
 * by the keyed derivation, so the source object adds no request input of its
 * own; whole-object uses (passed around, spread, returned) still require
 * direct key coverage.
 */
function isProjectionUse(identifier: NodePath<t.Identifier>): boolean {
  const parent = identifier.parentPath?.node;
  if (!parent) return false;
  if (
    (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
    parent.object === identifier.node
  )
    return true;
  if (t.isUnaryExpression(parent) && parent.operator === "!") return true;
  if (
    t.isBinaryExpression(parent) &&
    (parent.operator === "==" ||
      parent.operator === "===" ||
      parent.operator === "!=" ||
      parent.operator === "!==") &&
    (t.isNullLiteral(parent.left) || t.isNullLiteral(parent.right))
  )
    return true;
  if (t.isLogicalExpression(parent) && parent.operator === "??") return true;
  return (
    t.isCallExpression(parent) &&
    t.isIdentifier(parent.callee, { name: "Boolean" }) &&
    parent.arguments.some((arg) => arg === identifier.node)
  );
}

export const QueryKeyCompletenessRule: VerificationRule = {
  id: "QUERY-001",
  name: "Incomplete Server-State Query Key",
  description:
    "Detects React Query functions that depend on request inputs missing from their cache key.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        const isUseQuery =
          t.isIdentifier(callee, { name: "useQuery" }) ||
          (t.isMemberExpression(callee) &&
            t.isIdentifier(callee.property, { name: "useQuery" }));
        const options = path.get("arguments.0");
        if (!isUseQuery || !options.isObjectExpression()) return;
        const keyProperty = propertyOf(options.node, "queryKey");
        const fnProperty = propertyOf(options.node, "queryFn");
        if (!keyProperty || !fnProperty) return;
        const keyPath = options
          .get("properties")
          .find((property) => property.node === keyProperty);
        const fnPath = options
          .get("properties")
          .find((property) => property.node === fnProperty);
        if (!keyPath?.isObjectProperty() || !fnPath?.isObjectProperty()) return;
        const keyValue = keyPath.get("value");
        const fnValue = fnPath.get("value");
        if (!fnValue.isFunction()) return;
        const keyed = referencedNames(keyValue);
        if (keyValue.isIdentifier()) {
          const binding = keyValue.scope.getBinding(keyValue.node.name);
          if (
            binding &&
            binding.path.isVariableDeclarator() &&
            binding.path.node.init
          ) {
            for (const name of referencedNames(binding.path.get("init"))) {
              keyed.add(name);
            }
          }
        }
        const missing = new Set<string>();
        const references = new Map<string, NodePath<t.Identifier>[]>();
        fnValue.traverse({
          Identifier(identifier) {
            if (
              !identifier.isReferencedIdentifier() ||
              keyed.has(identifier.node.name)
            )
              return;
            const name = identifier.node.name;
            if (/token|password|secret|credential|accessCode/i.test(name))
              return;
            const binding = identifier.scope.getBinding(name);
            if (
              !binding ||
              binding.path.isImportSpecifier() ||
              binding.path.isImportDefaultSpecifier() ||
              binding.path.isImportNamespaceSpecifier() ||
              binding.path.isFunctionDeclaration()
            )
              return;
            if (binding.scope === fnValue.scope) return;
            if (binding.path.isVariableDeclarator()) {
              const init = binding.path.node.init;
              if (
                t.isStringLiteral(init) ||
                t.isNumericLiteral(init) ||
                t.isBooleanLiteral(init)
              )
                return;
            }
            missing.add(name);
            let refs = references.get(name);
            if (!refs) {
              refs = [];
              references.set(name, refs);
            }
            refs.push(identifier);
          },
        });
        if (missing.size === 0) return;
        // A candidate computed from a keyed input is covered when queryFn only
        // projects it (member reads and null guards): the key already depends
        // on the same source. E.g. key contains `generationId` derived from
        // `offlineDetails`, while queryFn reads `offlineDetails.database`
        // behind `if (!offlineDetails) throw`.
        const derived = derivedNamesFor(keyed, keyValue);
        const uncovered = [...missing].filter((name) => {
          if (!derived.has(name)) return true;
          const refs = references.get(name) ?? [];
          if (refs.every((ref) => isProjectionUse(ref))) return false;
          if (isCoveredObjectInput(name, fnValue, derived, refs)) return false;
          return true;
        });
        if (uncovered.length === 0) return;
        const names = uncovered.sort().slice(0, 5);
        report(
          ctx,
          keyProperty,
          "QUERY-001",
          `Query key omits request input${names.length > 1 ? "s" : ""}: ${names.join(", ")}.`,
          "React Query reuses cache entries by queryKey. Different requests sharing a key can display data from another filter, tenant, account, or screen state.",
          "Add every response-shaping input to queryKey using stable, non-secret identifiers; alternatively remove the input from queryFn.",
        );
      },
    });
  },
};

function isApiBoundary(filePath: string): boolean {
  return (
    /(?:^|[\\/])(?:api|services?|clients?)(?:[\\/]|\.|$)/i.test(filePath) ||
    /(?:api|service|client|upload)[^\\/]*\.[cm]?[jt]sx?$/i.test(filePath)
  );
}

export const RequestTimeoutRule: VerificationRule = {
  id: "SERVICE-003",
  name: "API Request Without Timeout",
  description:
    "Detects central API clients that can remain pending indefinitely.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    if (!isApiBoundary(ctx.filePath)) return;
    traverse(ctx.ast, {
      CallExpression(path) {
        if (
          t.isMemberExpression(path.node.callee) &&
          t.isIdentifier(path.node.callee.object, { name: "axios" }) &&
          t.isIdentifier(path.node.callee.property, { name: "create" })
        ) {
          const config = path.node.arguments[0];
          if (t.isObjectExpression(config) && !propertyOf(config, "timeout"))
            report(
              ctx,
              path.node,
              "SERVICE-003",
              "Central Axios client has no request timeout.",
              "A stalled connection can leave loading UI, submissions, and navigation pending indefinitely on poor mobile networks.",
              "Configure a bounded default timeout and allow explicit per-request overrides for long uploads.",
            );
          return;
        }
        if (!t.isIdentifier(path.node.callee, { name: "fetch" })) return;
        const options = path.node.arguments[1];
        if (t.isObjectExpression(options) && propertyOf(options, "signal"))
          return;
        const scope = path.getFunctionParent();
        if (
          scope &&
          /AbortSignal\.timeout|AbortController/.test(scope.toString())
        )
          return;
        report(
          ctx,
          path.node,
          "SERVICE-003",
          "API fetch has no timeout or abort signal.",
          "fetch has no built-in timeout, so a stalled request can keep the interface pending for an unbounded period.",
          "Pass an AbortSignal with a bounded timeout and compose it with caller cancellation.",
        );
      },
    });
  },
};

function isDevGuard(node: t.Node): boolean {
  let found = false;
  const inspect = (current: unknown): void => {
    if (!current || typeof current !== "object" || found) return;
    if (t.isIdentifier(current as t.Node, { name: "DEV" })) found = true;
    for (const value of Object.values(current as Record<string, unknown>)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === "object") inspect(value);
    }
  };
  inspect(node);
  return found;
}

export const DevOnlyResponseValidationRule: VerificationRule = {
  id: "SERVICE-004",
  name: "Development-Only API Validation",
  description:
    "Detects runtime response-schema validation disabled in production builds.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      IfStatement(path) {
        if (!isDevGuard(path.node.test)) return;
        let validation: t.CallExpression | null = null;
        path.get("consequent").traverse({
          CallExpression(call) {
            const callee = call.node.callee;
            if (
              t.isMemberExpression(callee) &&
              t.isIdentifier(callee.property) &&
              ["parse", "safeParse", "validate", "decode"].includes(
                callee.property.name,
              )
            )
              validation = call.node;
          },
        });
        if (!validation) return;
        report(
          ctx,
          validation,
          "SERVICE-004",
          "API response validation only runs in development.",
          "Production is where malformed, partially deployed, or backward-incompatible payloads occur; disabling validation turns contract drift into downstream crashes or corrupt UI state.",
          "Validate untrusted response data in every build and return the parsed value, using lightweight schemas where performance matters.",
        );
      },
    });
  },
};

export const UploadSizeValidationRule: VerificationRule = {
  id: "SERVICE-005",
  name: "Upload Without Size Bound",
  description:
    "Detects upload helpers that send a Blob/File without checking its size.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    if (!/upload/i.test(ctx.filePath)) return;
    traverse(ctx.ast, {
      Function(path) {
        const params = new Set<string>();
        for (const parameter of path.node.params) {
          if (t.isIdentifier(parameter) && /file|blob/i.test(parameter.name))
            params.add(parameter.name);
          if (t.isObjectPattern(parameter))
            for (const property of parameter.properties) {
              if (
                t.isObjectProperty(property) &&
                t.isIdentifier(property.value) &&
                /file|blob/i.test(property.value.name)
              )
                params.add(property.value.name);
            }
        }
        if (params.size === 0) return;
        let uploads = false;
        let checksSize = false;
        path.traverse({
          MemberExpression(member) {
            if (
              t.isIdentifier(member.node.object) &&
              params.has(member.node.object.name) &&
              t.isIdentifier(member.node.property, { name: "size" })
            )
              checksSize = true;
          },
          CallExpression(call) {
            const callee = call.node.callee;
            const method =
              t.isMemberExpression(callee) && t.isIdentifier(callee.property)
                ? callee.property.name
                : null;
            if (method === "put" || t.isIdentifier(callee, { name: "fetch" })) {
              if (
                call.node.arguments.some(
                  (argument) =>
                    t.isIdentifier(argument) && params.has(argument.name),
                )
              )
                uploads = true;
            }
          },
        });
        if (!uploads || checksSize) return;
        report(
          ctx,
          path.node,
          "SERVICE-005",
          "Upload helper sends a file without enforcing a size limit.",
          "Large user-selected files can exhaust memory, saturate mobile connections, exceed provider limits, and leave the UI stuck in a long-running request.",
          "Reject files above a documented byte limit before requesting or using the upload URL.",
        );
      },
    });
  },
};

function memberName(
  node: t.Expression | t.V8IntrinsicIdentifier,
): string | null {
  if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node))
    return null;
  if (!node.computed && t.isIdentifier(node.property))
    return node.property.name;
  if (node.computed && t.isStringLiteral(node.property))
    return node.property.value;
  return null;
}

export const RefreshSingleFlightRule: VerificationRule = {
  id: "RACE-009",
  name: "Uncoordinated Authentication Refresh",
  description:
    "Detects 401 interceptors that can start one token refresh per failed request.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    if (!/(?:auth|api|client|interceptor)/i.test(ctx.filePath)) return;
    traverse(ctx.ast, {
      CallExpression(path) {
        if (memberName(path.node.callee) !== "use") return;
        const text = path.toString();
        if (
          !/\b401\b/.test(text) ||
          !/(?:refreshToken|refreshAccessToken|\/refresh\b|refresh\s*\()/i.test(
            text,
          )
        )
          return;
        if (
          /(?:refreshPromise|isRefreshing|failedQueue|refreshQueue|subscribers|singleFlight|mutex)/i.test(
            text,
          )
        )
          return;
        const delegatesToCoordinatedRefresh = [
          ...ctx.projectFunctionBehaviors,
        ].some(
          ([name, behavior]) =>
            behavior.singleFlightRefresh &&
            new RegExp(
              `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`,
            ).test(text),
        );
        if (delegatesToCoordinatedRefresh) return;
        report(
          ctx,
          path.node,
          "RACE-009",
          "Concurrent 401 responses can start overlapping token refreshes.",
          "Parallel API failures may rotate credentials multiple times, overwrite a newer token, or retry requests with an invalidated token.",
          "Share one in-flight refresh promise, queue failed requests behind it, and clear the coordinator in finally.",
        );
      },
    });
  },
};

export const RetriedMutationIdempotencyRule: VerificationRule = {
  id: "MUTATION-001",
  name: "Retried Mutation Without Idempotency",
  description:
    "Detects automatically retried write mutations without an idempotency key.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (!(
          t.isIdentifier(path.node.callee, { name: "useMutation" }) ||
          memberName(path.node.callee) === "useMutation"
        ))
          return;
        const options = path.node.arguments[0];
        if (!t.isObjectExpression(options)) return;
        const retry = propertyOf(options, "retry");
        if (
          !retry ||
          t.isNumericLiteral(retry.value, { value: 0 }) ||
          t.isBooleanLiteral(retry.value, { value: false })
        )
          return;
        const text = path.toString();
        if (!/\.(?:post|put|patch|delete)\s*\(/i.test(text)) return;
        if (/(?:idempotency|requestId|operationId|mutationId)/i.test(text))
          return;
        report(
          ctx,
          retry,
          "MUTATION-001",
          "Automatically retried write mutation has no idempotency key.",
          "A timeout can occur after the server commits the write. Retrying can then create duplicate payments, applications, messages, or records.",
          "Attach a stable operation ID/idempotency key that is reused by every retry, or disable automatic retries for non-idempotent writes.",
        );
      },
    });
  },
};

export const InfiniteQueryPaginationRule: VerificationRule = {
  id: "QUERY-002",
  name: "Incomplete Infinite Query Pagination",
  description:
    "Detects infinite queries that omit cursor progression or ignore pageParam.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      CallExpression(path) {
        if (!(
          t.isIdentifier(path.node.callee, { name: "useInfiniteQuery" }) ||
          memberName(path.node.callee) === "useInfiniteQuery"
        ))
          return;
        const options = path.node.arguments[0];
        if (!t.isObjectExpression(options)) return;
        const next = propertyOf(options, "getNextPageParam");
        const query = propertyOf(options, "queryFn");
        if (!next) {
          report(
            ctx,
            options,
            "QUERY-002",
            "Infinite query has no getNextPageParam cursor policy.",
            "Pagination cannot reliably determine when to stop or which cursor follows the current page.",
            "Provide getNextPageParam and return undefined when the server has no next page.",
          );
          return;
        }
        const optionsPath = path.get("arguments.0");
        const queryPath = optionsPath.isObjectExpression()
          ? optionsPath
              .get("properties")
              .find((property) => property.node === query)
          : undefined;
        if (
          query &&
          t.isFunction(query.value) &&
          queryPath &&
          !/\bpageParam\b/.test(queryPath.toString())
        ) {
          report(
            ctx,
            query,
            "QUERY-002",
            "Infinite query ignores pageParam and can repeatedly fetch the first page.",
            "The cache may append duplicate records forever while the user believes they are loading subsequent pages.",
            "Read pageParam in queryFn and send it as the server cursor or offset.",
          );
        }
      },
    });
  },
};

export const OfflineReplayIdentityRule: VerificationRule = {
  id: "OFFLINE-001",
  name: "Offline Write Without Replay Identity",
  description:
    "Detects persisted offline writes without a stable operation identity.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    if (!/(?:offline|queue|outbox|sync)/i.test(ctx.filePath)) return;
    traverse(ctx.ast, {
      CallExpression(path) {
        const method = memberName(path.node.callee);
        if (!method || !["add", "push", "enqueue", "setItem"].includes(method))
          return;
        if (
          method === "add" &&
          t.isMemberExpression(path.node.callee) &&
          t.isIdentifier(path.node.callee.object)
        ) {
          const binding = path.scope.getBinding(path.node.callee.object.name);
          const init = binding?.path.isVariableDeclarator()
            ? binding.path.node.init
            : null;
          if (
            t.isNewExpression(init) &&
            t.isIdentifier(init.callee, { name: "Set" })
          )
            return;
        }
        const text = path.toString();
        if (!/(?:post|put|patch|delete|mutation|request|payload)/i.test(text))
          return;
        if (
          /(?:idempotency|operationId|mutationId|requestId|\buuid\b|randomUUID)/i.test(
            text,
          )
        )
          return;
        report(
          ctx,
          path.node,
          "OFFLINE-001",
          "Queued offline write has no stable replay identity.",
          "A crash or reconnect during acknowledgement can replay the same write and create duplicate server-side effects.",
          "Persist a generated operation ID with the queued item and send it as an idempotency key on every replay.",
        );
      },
    });
  },
};

export const RealtimeOrderingRule: VerificationRule = {
  id: "RACE-010",
  name: "Unordered Realtime State Replacement",
  description:
    "Detects realtime messages replacing state without rejecting older events.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      AssignmentExpression(path) {
        const left = path.node.left;
        if (
          !t.isMemberExpression(left) ||
          !t.isIdentifier(left.property) ||
          !["onmessage", "ondata", "onupdate"].includes(left.property.name)
        )
          return;
        if (!t.isFunction(path.node.right)) return;
        const text = path.get("right").toString();
        if (!/\bset[A-Z]\w*\s*\(/.test(text)) return;
        if (
          /(?:sequence|version|revision|updatedAt|timestamp|lastEventId)/i.test(
            text,
          )
        )
          return;
        report(
          ctx,
          path.node,
          "RACE-010",
          "Realtime callback replaces state without an ordering/version guard.",
          "Reconnects, buffered messages, and multiple transports can deliver older events after newer state has already rendered.",
          "Compare a server sequence, revision, or timestamp against the latest applied value before replacing state.",
        );
      },
    });
  },
};

export const DuplicateSubmissionRule: VerificationRule = {
  id: "MUTATION-002",
  name: "Unguarded Duplicate Submission",
  description:
    "Detects submit handlers that can invoke the same mutation repeatedly while it is pending.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      JSXAttribute(path) {
        if (
          !t.isJSXIdentifier(path.node.name) ||
          !["onSubmit", "onPress"].includes(path.node.name.name)
        )
          return;
        if (
          !t.isJSXExpressionContainer(path.node.value) ||
          !t.isIdentifier(path.node.value.expression)
        )
          return;
        const handler = path.node.value.expression.name;
        if (!/(?:submit|save|create|apply|pay|send|confirm)/i.test(handler))
          return;
        const binding = path.scope.getBinding(handler);
        const functionPath = binding?.path.isVariableDeclarator()
          ? binding.path.get("init")
          : binding?.path;
        if (!functionPath?.isFunction()) return;
        const text = functionPath.toString();
        if (!/(?:\.mutate(?:Async)?|\bmutate(?:Async)?)\s*\(/.test(text))
          return;
        const component = path.getFunctionParent()?.toString() ?? ctx.code;
        if (
          /(?:isPending|isLoading|submitting|inFlight|disabled)\b/i.test(
            text + component,
          )
        )
          return;
        report(
          ctx,
          functionPath.node,
          "MUTATION-002",
          `Submission handler '${handler}' has no pending-operation guard.`,
          "Rapid taps, Enter-key repeats, or delayed mobile feedback can dispatch the same mutation more than once.",
          "Return early while the mutation is pending and disable the submitting control; retain server-side idempotency for irreversible writes.",
        );
      },
    });
  },
};

export const DetailCacheIdentityRule: VerificationRule = {
  id: "QUERY-003",
  name: "Mutation Detail Cache Missing Identity",
  description:
    "Detects mutation callbacks writing entity-detail data into an unscoped cache key.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      ObjectProperty(path) {
        if (
          !(
            t.isIdentifier(path.node.key, { name: "onSuccess" }) ||
            t.isStringLiteral(path.node.key, { value: "onSuccess" })
          ) ||
          !t.isFunction(path.node.value)
        )
          return;
        const variables = path.node.value.params[1];
        if (!t.isIdentifier(variables)) return;
        path.get("value").traverse({
          CallExpression(call) {
            if (memberName(call.node.callee) !== "setQueryData") return;
            const key = call.node.arguments[0];
            if (
              !t.isArrayExpression(key) ||
              key.elements.length !== 1 ||
              !t.isStringLiteral(key.elements[0])
            )
              return;
            if (
              !/(?:detail|item|user|order|application|assessment|profile)$/i.test(
                key.elements[0].value,
              )
            )
              return;
            const callbackText = call.toString();
            if (!new RegExp(`\\b${variables.name}\\b`).test(callbackText))
              return;
            report(
              ctx,
              key,
              "QUERY-003",
              `Detail cache key '${key.elements[0].value}' omits the mutated entity identity.`,
              "Updates for different records will overwrite the same cache entry and can show one user's or entity's data on another screen.",
              `Include the stable entity ID from ${variables.name} in the setQueryData key.`,
            );
          },
        });
      },
      ObjectMethod(path) {
        if (!(
          t.isIdentifier(path.node.key, { name: "onSuccess" }) ||
          t.isStringLiteral(path.node.key, { value: "onSuccess" })
        ))
          return;
        const variables = path.node.params[1];
        if (!t.isIdentifier(variables)) return;
        path.traverse({
          CallExpression(call) {
            if (memberName(call.node.callee) !== "setQueryData") return;
            const key = call.node.arguments[0];
            if (
              !t.isArrayExpression(key) ||
              key.elements.length !== 1 ||
              !t.isStringLiteral(key.elements[0])
            )
              return;
            if (
              !/(?:detail|item|user|order|application|assessment|profile)$/i.test(
                key.elements[0].value,
              )
            )
              return;
            if (!new RegExp(`\\b${variables.name}\\b`).test(call.toString()))
              return;
            report(
              ctx,
              key,
              "QUERY-003",
              `Detail cache key '${key.elements[0].value}' omits the mutated entity identity.`,
              "Updates for different records will overwrite the same cache entry and can show one user's or entity's data on another screen.",
              `Include the stable entity ID from ${variables.name} in the setQueryData key.`,
            );
          },
        });
      },
    });
  },
};

export const AsyncLoadingTerminalStateRule: VerificationRule = {
  id: "STATE-001",
  name: "Async Loading State Can Remain Stuck",
  description:
    "Detects async operations that clear loading only on the success path.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    traverse(ctx.ast, {
      Function(path) {
        if (!path.node.async) return;
        const text = path.toString();
        const start = text.match(
          /\b(set[A-Z]\w*(?:Loading|Pending)|setLoading)\s*\(\s*true\s*\)/,
        );
        if (!start || !/\bawait\b/.test(text)) return;
        const setter = start[1];
        if (!new RegExp(`\\b${setter}\\s*\\(\\s*false\\s*\\)`).test(text))
          return;
        let safeFinally = false;
        path.traverse({
          TryStatement(inner) {
            if (
              inner.node.finalizer &&
              new RegExp(`\\b${setter}\\s*\\(\\s*false\\s*\\)`).test(
                inner.get("finalizer").toString(),
              )
            )
              safeFinally = true;
          },
        });
        if (safeFinally) return;
        report(
          ctx,
          path.node,
          "STATE-001",
          `Loading setter '${setter}' is not cleared in finally.`,
          "If an awaited request rejects before the success-path reset, the UI can remain permanently disabled or show an endless spinner.",
          `Move ${setter}(false) into a finally block that covers every awaited operation after loading begins.`,
        );
      },
    });
  },
};

export const AvailableSchemaNotAppliedRule: VerificationRule = {
  id: "SERVICE-006",
  name: "Available API Schema Not Applied",
  description:
    "Detects service modules returning raw response data despite importing a response schema.",
  category: "CORRECTNESS",
  defaultSeverity: "MEDIUM",
  check(ctx) {
    if (!isApiBoundary(ctx.filePath)) return;
    const schemas = new Set<string>();
    for (const statement of ctx.ast.program.body)
      if (t.isImportDeclaration(statement)) {
        for (const specifier of statement.specifiers)
          if (
            (t.isImportSpecifier(specifier) ||
              t.isImportDefaultSpecifier(specifier)) &&
            /Schema$/.test(specifier.local.name) &&
            !/^(?:create|make|build|get)Api[A-Z]/.test(specifier.local.name)
          )
            schemas.add(specifier.local.name);
      }
    if (schemas.size === 0) return;
    traverse(ctx.ast, {
      Function(path) {
        const text = path.toString();
        let returnsRawRequestData = false;
        path.traverse({
          ReturnStatement(returnPath) {
            let member = returnPath.node.argument;
            let responseName: string | null = null;
            while (t.isMemberExpression(member) && !member.computed) {
              if (
                t.isIdentifier(member.object) &&
                t.isIdentifier(member.property, { name: "data" })
              ) {
                responseName = member.object.name;
                break;
              }
              member = member.object;
            }
            if (!responseName) return;

            const binding = returnPath.scope.getBinding(responseName);
            if (!binding?.path.isVariableDeclarator()) return;
            const init = binding.path.node.init;
            if (!t.isAwaitExpression(init) || !t.isCallExpression(init.argument))
              return;

            const callee = init.argument.callee;
            const isFetch = t.isIdentifier(callee, { name: "fetch" });
            const isHttpClientMethod =
              t.isMemberExpression(callee) &&
              !callee.computed &&
              t.isIdentifier(callee.property) &&
              ["get", "post", "put", "patch", "delete"].includes(
                callee.property.name,
              );
            if (isFetch || isHttpClientMethod) returnsRawRequestData = true;
          },
        });
        if (!returnsRawRequestData) return;
        if (
          [...schemas].some((schema) =>
            new RegExp(
              `\\b${schema}\\s*\\.\\s*(?:parse|safeParse)\\s*\\(|(?:responseSchema|schema)\\s*:\\s*${schema}\\b`,
            ).test(text),
          )
        )
          return;
        report(
          ctx,
          path.node,
          "SERVICE-006",
          `Raw API response bypasses an imported runtime schema (${[...schemas].join(", ")}).`,
          "The module declares the expected wire contract but lets malformed production payloads escape into hooks and components unchecked.",
          "Parse response.data with the matching schema and return the parsed value from the service boundary.",
        );
      },
    });
  },
};

export const UnawaitedInvalidationRule: VerificationRule = {
  id: "QUERY-004",
  name: "Mutation Cache Invalidation Not Awaited",
  description:
    "Detects mutation callbacks that finish before asynchronous cache invalidation completes.",
  category: "CORRECTNESS",
  defaultSeverity: "LOW",
  check(ctx) {
    const reportedCallbacks = new WeakSet<t.Node>();
    traverse(ctx.ast, {
      CallExpression(path) {
        if (memberName(path.node.callee) !== "invalidateQueries") return;
        const callback = path.getFunctionParent();
        if (!callback) return;
        const owner = callback.isObjectMethod()
          ? callback
          : callback.parentPath;
        const isMutationCallback =
          (owner.isObjectProperty() || owner.isObjectMethod()) &&
          ((t.isIdentifier(owner.node.key) &&
            ["onSuccess", "onSettled"].includes(owner.node.key.name)) ||
            (t.isStringLiteral(owner.node.key) &&
              ["onSuccess", "onSettled"].includes(owner.node.key.value)));
        if (!isMutationCallback) return;
        if (
          path.parentPath.isAwaitExpression() ||
          path.parentPath.isReturnStatement() ||
          path.parentPath.isUnaryExpression({ operator: "void" }) ||
          (callback.isArrowFunctionExpression() &&
            callback.node.body === path.node)
        )
          return;
        let exitsAfterInvalidation = false;
        callback.traverse({
          CallExpression(other) {
            if ((other.node.start ?? 0) <= (path.node.end ?? 0)) return;
            const callee = other.node.callee;
            if (
              t.isIdentifier(callee) &&
              [
                "navigate",
                "onClose",
                "closeModal",
                "dismiss",
                "resetForm",
              ].includes(callee.name)
            )
              exitsAfterInvalidation = true;
            if (
              t.isMemberExpression(callee) &&
              t.isIdentifier(callee.object, { name: "router" }) &&
              t.isIdentifier(callee.property) &&
              ["push", "replace", "back"].includes(callee.property.name)
            )
              exitsAfterInvalidation = true;
          },
        });
        if (!exitsAfterInvalidation) return;
        if (reportedCallbacks.has(callback.node)) return;
        reportedCallbacks.add(callback.node);
        report(
          ctx,
          path.node,
          "QUERY-004",
          "Mutation callback does not await or return cache invalidation.",
          "The mutation can become successful and navigation or rendering can continue while affected queries still contain stale data.",
          "Await invalidateQueries, return its promise, or explicitly document that background invalidation is intentional.",
          "LOW",
        );
      },
    });
  },
};

export const SERVER_STATE_RULES: VerificationRule[] = [
  QueryKeyCompletenessRule,
  RequestTimeoutRule,
  DevOnlyResponseValidationRule,
  UploadSizeValidationRule,
  RefreshSingleFlightRule,
  RetriedMutationIdempotencyRule,
  InfiniteQueryPaginationRule,
  OfflineReplayIdentityRule,
  RealtimeOrderingRule,
  DuplicateSubmissionRule,
  DetailCacheIdentityRule,
  AsyncLoadingTerminalStateRule,
  AvailableSchemaNotAppliedRule,
  UnawaitedInvalidationRule,
];
