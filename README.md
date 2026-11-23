# Code Verifier

A static verification and security engine for **React, React Native, Expo, and TypeScript**, built for LLM coding agents and CI gates. It combines Babel AST pattern rules, formal abstract interpretation, and TypeScript semantic analysis to catch real runtime bugs without noisy dashboards.

---

## Real Example Output

Caught by `verify_code` on a real-world React hook where lazy ref initialization breaks React 19.2+ and the React Compiler:

```markdown
### ⚠️ Code Verification: FAILED (2 issues found)
- File: `src/hooks/useSessionCoordinator.ts`
- Summary: Found 0 Critical, 2 High, 0 Medium issues.

**Issue #1: [HIGH] REACT-007 - 'coordinatorRef.current' is accessed during render.**
- **Location**: Line 22, Col 6
- **Category**: REACT_HOOKS
- **Confidence**: HIGH
- **Explanation**: Refs are imperative escapes and are not safe to read or write while rendering: React 19.2+ throws "Cannot access refs during render" in development, and the React Compiler requires render to be ref-free.
- **Offending Code**:
```tsx
    21 |
>   22 |   if (coordinatorRef.current === null) {
    23 |     coordinatorRef.current = new SessionCoordinator({
```
- **LLM Remediation Action**: Hoist the value out of the ref: `useState(() => new SessionCoordinator(...))[0]` for a stable per-instance value, or move `.current` access into Effects and event handlers.
```

---

## 60-Second Quick Start

### Add to your MCP client (`mcp_config.json`)

```json
{
  "mcpServers": {
    "code-verifier": {
      "command": "npx",
      "args": ["-y", "code-verifier", "mcp"]
    }
  }
}
```

*(Pass `"--experimental"` in `args` to also enable Experimental test-generation and TDR tools.)*

### Top 3 CLI Commands

```bash
# 1. Verify a file or directory with LLM-ready Markdown diagnostics
npx code-verifier src/

# 2. Emit SARIF 2.1.0 for GitHub Code Scanning / CI gates
npx code-verifier src/ --format=sarif > results.sarif

# 3. Incremental scan on Git-changed files only
npx code-verifier src/ --changed --workers=8
```

Exit codes: `0` = passed (no findings at or above `--fail-on`, default `MEDIUM`), `1` = threshold reached, `2` = incomplete verification or configuration error.

---

## Core MCP Tools

Exposed by default over stdio JSON-RPC (`npx -y code-verifier mcp`):

- **`verify_code`** — `{ code, filePath?, format? }`
  Runs SAST pattern rules + abstract interpretation on TypeScript/TSX/JSX source and returns LLM-ready remediation Markdown or structured JSON.
- **`get_test_context`** — `{ filePath, code? }`
  Extracts framework detection (`vitest` / `jest` / `detox`), module classification (`component` / `hook` / `service`), exported contracts, synthesized dependency mocks, and static findings so an LLM can write accurate unit tests.

### Experimental Tools (`--experimental`)

Launch with `npx -y code-verifier mcp --experimental` to enable beta workflows:

- **`generate_tests`** *(Experimental)* — `{ filePath, code?, framework?, ruleFilter? }`: Scaffolds Jest/Vitest/Detox test suites from static analysis facts.
- **`start_tdr_session`** *(Experimental)* — `{ sourceFile, framework? }`: Starts a Test-Driven Remediation session and persists baseline findings.
- **`verify_fix`** *(Experimental)* — `{ sessionId, sourceFile, runTests?, testCommand? }`: Re-verifies static findings and optionally runs tests against a TDR session.
- **`get_tdr_status`** *(Experimental)* — `{ sessionId }`: Inspects a persisted TDR session.

---

## Supported Languages & Frameworks

### Languages
- **TypeScript & TSX** (`.ts`, `.tsx`) — full AST rules, abstract interpretation, and compiler-backed TypeScript semantic checks (`TYPE-001`, `TYPE-002`).
- **JavaScript & JSX** (`.js`, `.jsx`, `.mjs`, `.cjs`) — Babel AST rules and abstract interpretation.
- **Config / Manifest Formats** — Expo `app.json`, `AndroidManifest.xml`, `Info.plist`, `Podfile.lock`, Dockerfiles, GitHub Actions YAML, Kubernetes YAML, and Terraform `.tf`.

### Frameworks & Libraries
- **React** (including **React 19** migration, hook rules, render-phase ref checks, and Fast Refresh rules)
- **React Native & Expo** (AsyncStorage, WebView security, `FlatList`, `Animated`, `PanResponder`, Expo Router, `Podfile.lock` native autolinking, and Android/iOS mobile config)
- **TanStack Query / React Query** (query keys, infinite pagination, cache invalidation, mutation idempotency)
- **HTTP & Validation** (`fetch`, `axios`, Zod-style schema validation)
- **Node / Web Backend APIs** (Express-style route auth, SQL/command/path/SSRF injection, JWT verification, cookies, CORS, error leakage)
- **Testing Frameworks** (**Jest**, **Vitest**, **Detox**, and React Testing Library)

---

## Rule Categories Summary

Code Verifier ships **128** registry rules (plus project-wide `HYG-004` dead-file detection). See [docs/RULES.md](docs/RULES.md) for the complete rule table, or run `npx code-verifier --list-rules`.

- **Security & Injection (`SEC-*`, `RN-SEC-*`, `WEB-*`, `NET-*`, `AUTH-*`)**: Hardcoded secrets, `eval()`, `dangerouslySetInnerHTML`, SQL/command/path injection, SSRF, prototype pollution, insecure cookies/CORS, unverified JWTs, AsyncStorage/localStorage leaks, and WebView XSS/TLS misconfigurations.
- **React & React 19 (`REACT-*`)**: Conditional hooks, infinite `useEffect` loops, missing effect cleanups, stale closures, render-phase ref access (`REACT-007`), Fast Refresh hazards (`REACT-020`), and removed React 19 APIs (`REACT-009`–`019`).
- **Abstract Interpretation & Type Semantics (`AI-NULL-001`, `AI-TAINT-001`, `TYPE-001`–`002`)**: Path-sensitive null/undefined dereferences, source-to-sink taint tracking, floating Promises, and Promise-valued conditions.
- **Async Races & Server State (`RACE-*`, `QUERY-*`, `MUTATION-*`, `OFFLINE-*`, `STATE-*`)**: Disconnected `AbortController`s, stale async overwrites, unawaited cache invalidations, incomplete React Query keys/pagination, retried mutations without idempotency keys, and stuck loading flags.
- **Forms, Services & Component Contracts (`FORM-*`, `SERVICE-*`, `COMP-*`, `STYLE-*`)**: Unvalidated schema-backed forms, silent submit returns, unparsed API responses, missing upload size bounds, missing required props, and undefined CSS/style keys.
- **React Native, Expo & Mobile Config (`RN-COR-*`, `MOB-*`, `NAV-*`, `NAT-001`)**: `FlatList` index keys, `Animated` `useNativeDriver` mismatches, Expo Router route exports, `Podfile.lock` autolinking drift, and Android/iOS manifest/plist security checks.
- **Reliability, Logic & Hygiene (`LOGIC-*`, `ASYNC-*`, `REL-*`, `HYG-*`, `API-*`, `SUP-*`, `IAC-*`, `TEST-001`)**: Unreachable code, NaN comparisons, empty catch blocks, `finally` control-flow overrides, unused imports/files, API error leaks, GitHub Actions/Docker/K8s/Terraform hardening, and React test anti-patterns.

---

## Configuration & Suppressions

### Project Config (`.codeverifier.json`)

Discovered by walking up from the target path (all keys optional):

```json
{
  "exclude": ["**/generated/**", "**/*.test.ts"],
  "disable": ["HYG-001", "WEB-001"],
  "severities": { "NET-001": "INFO", "SEC-003": "MEDIUM" },
  "failOn": "HIGH",
  "baseline": ".codeverifier-baseline.json"
}
```

- `exclude` — glob patterns (`**` crosses directories, `*` stays in one segment; also matched against basename)
- `disable` — rule IDs or family prefixes (e.g. `"SEC"` disables all `SEC-*` rules)
- `severities` — remap rule severities
- `failOn` — lowest severity that fails the run: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, or `INFO`
- `baseline` — baseline file path; matching fingerprints are suppressed

### Inline Suppressions

```tsx
// code-verifier-disable-next-line
await AsyncStorage.setItem("cache_blob", blob);
```

Also available: `// code-verifier-disable` (this + next line) and `// code-verifier-disable-file`.

Hit a false positive? [Open a false-positive report](https://github.com/iniola145/Code-Verifier/issues/new/choose) with the rule ID and a minimal snippet.

---

## How It Works & Honest Limitations

### Analysis Pipeline

1. **Parsing** ([src/parser/ast.ts](src/parser/ast.ts)) — Babel parse for TS/TSX/JS/JSX, decorators, and top-level `await`.
2. **CFG Construction** ([src/cfg/builder.ts](src/cfg/builder.ts)) — Per-function Control Flow Graphs with `if`/`else`, loops, `switch`, `try`/`catch`/`finally`, and labeled branch conditions.
3. **Abstract Interpretation** ([src/abstract-interpreter/fixpoint.ts](src/abstract-interpreter/fixpoint.ts)) — Worklist fixed-point with widening (`∇`), path-sensitive refinement ([refine.ts](src/abstract-interpreter/refine.ts)), TypeScript annotation seeding ([ts-types.ts](src/abstract-interpreter/ts-types.ts)), and bounded cross-file function summaries ([function-summaries.ts](src/abstract-interpreter/function-summaries.ts)).
4. **Type Semantics & Pattern Rules** ([src/semantic-analysis.ts](src/semantic-analysis.ts), [src/rules/](src/rules/)) — Shared TypeScript `TypeChecker` for Promise semantics plus 128 AST/project rules.
5. **Platform Checks** ([src/mobile-config.ts](src/mobile-config.ts), [src/native-consistency.ts](src/native-consistency.ts)) — Expo/Android/iOS config checks and `ios/Podfile.lock` pod cross-checks.

### Running Tests

```bash
npm test          # 553 unit & integration tests
npm run benchmark # Precision/recall regression gate (>= 95%)
```

### Honest Limitations

- The 128 rules cover selected correctness, reliability, quality, framework, platform/deployment configuration, supply-chain, API, and CWE classes; they do not guarantee defect-free or secure software. Use this verifier alongside type checking, linting, tests, dependency scanning, platform tooling, and review.
- The transfer function models assignments of literals, identifiers, arithmetic, `await`, logicals, unary, and property reads. Unmodeled expressions become `Top` — **unknown values are never reported as null dereferences**, so precision is limited but reports are trustworthy.
- Taint sources/sinks remain a curated list; anything outside it (for example arbitrary `fetch` responses) is not automatically treated as tainted. Field paths, expression recursion, destructuring, standard collection callbacks, and parameter-to-return/sink summaries are bounded to keep scans terminating and findings explainable.
- Cross-file analysis follows relative ESM imports/re-exports and TypeScript `baseUrl`/`paths` mappings only when the resolved target is already in the analyzed file set. External packages, mutable module state, dynamic property names, and general interprocedural control flow are not modeled.
- Switch fallthrough analysis is approximate; labeled `break`/`continue` are treated as unlabeled.
- Framework rules intentionally recognize explicit, statically provable forms. WebView settings hidden in spread props, dynamically computed `postMessage` origins, TLS options assembled through aliases, and cleanup performed only through opaque helper functions may require project linting or manual review.
- Injection and resource rules trace explicit request, navigation, browser-location, and process-argument sources through constant local bindings and bounded expressions. Custom framework request objects, mutations, dynamically selected APIs, and sanitizer semantics outside modeled helpers require additional configuration or review.
- Compiler-backed Promise checks currently run for TypeScript/TSX source in CLI project scans. JavaScript remains syntax/abstract-analysis based unless a later phase enables project-specific `checkJs` semantics.
- Mobile configuration analysis targets explicit backup, cleartext/ATS, exported components, debuggable releases, document sharing, and a narrow high-risk permission set in Expo JSON, Android manifests, and iOS plists; it is not a complete MASVS or store-policy audit.
- Kubernetes and Terraform checks intentionally cover explicit high-confidence privilege and public administrative-ingress settings. They do not replace schema validation, policy-as-code, cloud-provider analysis, or runtime posture management.

---

## Frontend AI Harness (Waitlist)

Building deterministic verification and test harnesses for AI frontend teams — **[Join the Frontend AI Harness waitlist →](https://docs.google.com/forms/d/e/1FAIpQLSflAHMBO7ER6ERwb5BWAkkS1iXk6HxXnlfpRe4J89Gq7ZDsYQ/viewform?usp=publish-editor)**
