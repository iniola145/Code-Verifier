# Code Verifier (SAST + Abstract Interpretation for LLMs)

A static verification and security engine for **React, React Native, and Expo** codebases, designed to be consumed by **LLM agents and AI coding assistants** — analyze, verify, and remediate code without human dashboards.

---

## 🚀 Capabilities

1. **SAST + Abstract Interpretation**
   - Pattern rules over the Babel AST, plus formal abstract interpretation.
   - Computes least fixed-points over per-function Control Flow Graphs with **widening (∇)** and **path-sensitive condition refinement** (e.g. `if (user === null) return;` narrows the else-path to non-null).
   - Abstract domains:
     - **Nullability**: proves/flags actual null/undefined dereferences (CWE-476).
     - **Taint tracking**: source→sink flows from deep links, navigation params, and unencrypted storage into `AsyncStorage`/WebView sinks (CWE-312 / CWE-79).
     - **Interval domain**: numeric bounds with widening; used internally and surfaced in invariants.
2. **Implemented TypeScript / React / React Native / Expo / Web Rules** (79 rules)
   | Rule | Check | CWE |
   |---|---|---|
   | `RN-SEC-001` | Sensitive data in unencrypted `AsyncStorage` | CWE-312 |
   | `RN-SEC-002` | Dynamic HTML / `injectedJavaScript` into WebView | CWE-79 |
   | `RN-SEC-003` | Unsafe WebView file access or always-allow mixed content | CWE-749 |
   | `REACT-001` | Unconditional setState in `useEffect` without deps (infinite re-render) | CWE-835 |
   | `REACT-002` | Conditional hook invocation (ifs, loops, ternaries, `&&`/`\|\|`, scoped to the enclosing function) | Rules of Hooks |
   | `REACT-003` | Effect creates an interval/event listener without cleanup | React lifecycle |
   | `SEC-003` | Hardcoded secrets (Stripe, GitHub, AWS, Slack, Google, JWT, PEM) in consts, object literals, and assignments | CWE-798 |
   | `AI-NULL-001` | Null/undefined dereference via abstract interpretation, with HIGH severity when definite | CWE-476 |
   | `AI-TAINT-001` | Untrusted value flows into an unencrypted-storage or WebView sink | CWE-312/79 |
   | `SEC-004` | `eval()` / `new Function()` | CWE-95 |
   | `SEC-005` | Dynamic `dangerouslySetInnerHTML` | CWE-79 |
   | `SEC-006` | Secrets in web `localStorage`/`sessionStorage` | CWE-922 |
   | `SEC-007` | Request/process input in an OS command string | CWE-78 |
   | `SEC-008` | Request input interpolated into SQL execution APIs | CWE-89 |
   | `SEC-009` | Request-controlled outbound URL (SSRF) | CWE-918 |
   | `SEC-010` | Request-controlled filesystem path | CWE-22 |
   | `SEC-011` | Weak randomness or broken hashes in security-sensitive contexts | CWE-338/328 |
   | `SEC-012` | Request-controlled property key write (prototype pollution) | CWE-1321 |
   | `SEC-013` | Credentials, tokens, session identifiers, or payment secrets written to logs | CWE-532 |
   | `SEC-014` | Authentication JWT decoded without signature verification | CWE-347 |
   | `SEC-015` | Whole request object passed into persistence or object assignment | CWE-915 |
   | `SEC-016` | Session cookie missing explicit Secure, HttpOnly, or restrictive SameSite attributes | CWE-614 |
   | `SEC-017` | Credentialed CORS with wildcard or reflected origins | CWE-942 |
   | `LOGIC-001` | Assignment used as a branch or loop condition | Correctness |
   | `LOGIC-002` | Value-producing array callback with no return | Correctness |
   | `LOGIC-003` | Unreachable statement after unconditional control flow | Correctness |
   | `ASYNC-001` | Async callback passed to `forEach`, which does not await promises | Correctness |
   | `ASYNC-002` | Async function used as a Promise constructor executor | Correctness |
   | `REACT-004` | Async function passed directly to an Effect | React lifecycle |
   | `REACT-005` | Array index used as a React list key | React reconciliation |
   | `REACT-006` | Effect timer captures stale state instead of using a functional update | React state |
   | `REACT-007` | Ref `.current` read or written during render (React 19.2+ throws "Cannot access refs during render"; includes the `useRef(new Animated.Value(1)).current` idiom) | React refs |
   | `REACT-008` | State variable declared but never read (set-but-never-rendered state), or state whose setter is never called (constant state) | React state |
   | `REACT-009` | Removed ReactDOM / ReactDOMServer APIs called: `render`, `hydrate`, `unmountComponentAtNode`, `findDOMNode`, `unstable_renderSubtreeIntoContainer`, node-stream renderers (throws at runtime) | React 19 upgrade |
   | `REACT-010` | `React.createFactory(...)` called (removed in React 19) | React 19 upgrade |
   | `REACT-011` | String ref on a JSX element (`ref="name"` — removed in React 19, the ref never resolves) | React 19 upgrade |
   | `REACT-012` | Legacy Context members `contextTypes`, `childContextTypes`, `getChildContext` (removed in React 19) | React 19 upgrade |
   | `REACT-013` | `defaultProps` assigned on a function component (removed for function components in React 19 — defaults silently ignored; class components exempt) | React 19 upgrade |
   | `REACT-014` | `propTypes` declared on a component (React 19 no longer validates them — checks silently disappear) | React 19 upgrade |
   | `REACT-015` | `useRef()` called without an initial value (type error under @types/react 19; `.current` starts undefined) | React 19 types |
   | `REACT-016` | `use(...)` called inside a try clause (React throws "Hooks cannot be called inside try clauses") | React 19 hooks |
   | `REACT-017` | Callback ref implicitly returns a non-function value (React 19 cleanup-function semantics) | React 19 refs |
   | `REACT-018` | Import from `react-dom/test-utils` (removed in React 19; `act` moved to `React.act`) | React 19 testing |
   | `REACT-019` | `forwardRef` wrapper no longer needed — React 19 passes `ref` as a regular prop (advisory; forwardRef still works for React < 19 consumers) | React 19 upgrade |
   | `REACT-020` | Module defines components **and** exports non-component values (route tables, config objects, helpers) — Fast Refresh (Vite/Metro) cannot hot-swap it, so edits fall back to a full reload and drop state. Type exports, hook exports, re-exports, and primitive constant exports are exempt | Fast Refresh |
   | `HYG-002` | `const`/`let` or function declaration never referenced afterwards (or assigned but never read); exports, destructuring, and `_`-prefixed names exempt | Dead code |
   | `RN-COR-001` | FlatList or SectionList key extractor returns the item index | React Native lists |
   | `RN-COR-002` | Mixed `useNativeDriver` values within one `Animated.parallel`/`sequence`/`stagger` group | React Native animations |
   | `RN-COR-003` | Ref latch set before an animation starts is only cleared on the finished path, so an interrupted animation leaves it stuck | React Native animations |
   | `RN-COR-004` | Capture-phase `onStartShouldSetPanResponderCapture` returning constant true steals touches from children (advisory) | React Native gestures |
   | `REL-001` | Undocumented empty catch silently discards an exception | Reliability |
   | `REL-002` | Return/throw/break/continue in `finally` overrides pending completion | Correctness |
   | `QUAL-001` | `map()` allocates a result array that is ignored | Performance/quality |
   | `TYPE-001` | Type-proven Promise is left floating without handling | Type-aware correctness |
   | `TYPE-002` | Promise object is used directly as a boolean condition | Type-aware correctness |
   | `MOB-001` | Android/Expo application backup explicitly enabled | Mobile configuration |
   | `MOB-002` | Android cleartext traffic or global iOS ATS opt-out | Mobile configuration |
   | `MOB-003` | Exported Android component without a manifest permission | Mobile configuration |
   | `MOB-004` | Android application explicitly shipped as debuggable | Mobile configuration |
   | `MOB-005` | iOS document sharing exposes the app Documents directory | Mobile configuration |
   | `MOB-006` | Especially high-risk Android permission requested by Expo config | Mobile configuration |
   | `API-001` | Raw exception message or stack returned to an API client | CWE-209 |
   | `API-002` | Error payload returned with an HTTP success status | API correctness |
   | `API-003` | Handler continues after sending a conditional response | API correctness |
   | `AUTH-001` | Explicit administrative route without authorization middleware | CWE-862 |
   | `SUP-001` | GitHub Action not pinned to a full commit SHA | Supply chain |
   | `SUP-002` | GitHub Actions token granted `write-all` permissions | Supply chain |
   | `SUP-003` | Secret-bearing Docker `ARG` or `ENV` instruction | Container security |
   | `SUP-004` | Docker runtime stage runs as root | Container security |
   | `IAC-001` | Privileged Kubernetes container or host namespace sharing | Kubernetes security |
   | `IAC-002` | Kubernetes privilege escalation or explicit root execution | Kubernetes security |
   | `IAC-003` | Terraform exposes SSH/RDP ingress to the public internet | Cloud configuration |
   | `WEB-001` | `target="_blank"` without `rel="noopener"` (advisory) | CWE-1022 |
   | `WEB-002` | Browser `postMessage` with wildcard target origin | CWE-346 |
   | `HYG-001` | `debugger` statement left in code (advisory) | CWE-489 |
   | `NET-001` | Insecure `http://` URL in a URL-bearing context (advisory) | CWE-319 |
   | `NET-002` | TLS certificate verification explicitly disabled | CWE-295 |
   | `NAV-001` | Expo Router route file under `app/` without a default export (screens fail to render at runtime) | Expo Router conventions |
   | `NAT-001` | JS-imported package declares an iOS pod that is absent from `ios/Podfile.lock` — the installed native app is stale and will crash when the module is used | Expo/RN autolinking |
3. **Engineered for LLMs**
   - High-signal markdown diagnostics with AST snippets, abstract invariants, and remediation prompts.
   - Structured JSON with exact ranges.
   - **SARIF 2.1.0** output for GitHub code scanning and CI gates.
   - Stable finding fingerprints, baseline adoption, deterministic output, and configurable severity gates for large repositories.
   - **MCP server** (`verify_code` tool) for Cursor / Claude / any MCP client.

## 🛠️ Usage

### 1. CLI

```bash
# Single file (markdown for LLM, default)
npx ts-node src/cli.ts src/screens/HomeScreen.tsx

# Multiple files AND directories (walked recursively; node_modules/dist skipped)
npx ts-node src/cli.ts src/ --format=summary

# Machine-readable outputs
npx ts-node src/cli.ts src/ --format=json
npx ts-node src/cli.ts src/ --format=sarif > results.sarif

# Pipe via stdin
cat src/App.tsx | npx ts-node src/cli.ts --stdin

# Pattern rules only
npx ts-node src/cli.ts src/ --no-ai

# Include repository-local TypeScript and ESLint checks
npx ts-node src/cli.ts src/ --project-checks --format=report

# Incremental large-repository scans
npx ts-node src/cli.ts src/ --changed --workers=8
npx ts-node src/cli.ts src/ --cache=.codeverifier-cache.json

# Inspect the rule catalog (human-readable or machine-readable)
npx ts-node src/cli.ts --list-rules
npx ts-node src/cli.ts --list-rules --json

# Adopt an existing repository without hiding newly introduced findings
npx ts-node src/cli.ts src/ --write-baseline=.codeverifier-baseline.json
npx ts-node src/cli.ts src/ --baseline=.codeverifier-baseline.json --fail-on=HIGH
```

Exit codes: `0` = completed with no findings at or above the configured threshold, `1` = threshold reached, `2` = verification incomplete or usage/configuration error. The default threshold is `MEDIUM`, so LOW/INFO findings are advisory unless `--fail-on=LOW` or `--fail-on=INFO` is selected. The default output still lists advisory findings per passing file under an `⚠️ Advisory` heading; `--fail-on=LOW` makes them blocking.

Every result has an explicit status:

- `PASSED` — all required checks completed and no blocking findings exist.
- `FAILED` — at least one non-baselined finding reaches the configured failure threshold.
- `INCOMPLETE` — analysis could not establish a result because parsing, a rule, or abstract interpretation failed or was truncated.

The legacy `passed` boolean remains available and is true only for `PASSED`. Results also include per-stage `checks`, so CI and LLM consumers can distinguish findings from verifier failures.

`--project-checks` runs the repository's TypeScript, ESLint, build, test, dependency-audit, and Expo Doctor checks when applicable. TypeScript, ESLint, and Expo Doctor use repository-local binaries; build and test use declared npm scripts with `CI=true`; dependency audit requires an npm lockfile and never applies fixes. Commands use no shell and have bounded execution time/output. Missing required tools, timeouts, network failures, and unreadable tool output make verification `INCOMPLETE`; completed checks with findings make it `FAILED`.

### 2. Programmatic API

```typescript
import { CodeVerifier, LLMFormatter } from './src';

const verifier = new CodeVerifier();
const result = await verifier.verifyCode(sourceCodeString, 'HomeScreen.tsx');

if (!result.passed) {
  const llmPrompt = LLMFormatter.formatForLLMPrompt(result); // or formatSARIF([result])
  console.log(llmPrompt);
}
```

### 3. MCP Server

```bash
npm run mcp
```

Exposes `verify_code`: `{ code, filePath?, format? }` over stdio JSON-RPC.

### 4. GitHub Action

```yaml
- uses: your-org/code-verifier@v1
  with:
    targets: src,app
    format: sarif
    fail-on: HIGH
```

The repository includes a Node 20 `action.yml` entry point. Build and commit `dist/` before publishing an Action release tag. SARIF can be redirected or uploaded by the surrounding workflow according to repository policy.

### 5. Per-project config (`.codeverifier.json`)

Discovered by walking up from the analyzed path. All keys optional:

```json
{
  "exclude": ["**/generated/**", "**/*.test.ts"],
  "disable": ["HYG-001", "WEB-001"],
  "severities": { "NET-001": "INFO", "SEC-003": "MEDIUM" },
  "failOn": "HIGH",
  "baseline": ".codeverifier-baseline.json"
}
```

- `exclude` — glob patterns (`**` crosses directories, `*` stays in one segment; also matched against the basename)
- `disable` — rule ids; a prefix like `SEC` disables the whole `SEC-*` family
- `severities` — remap a rule's severity
- `failOn` — lowest severity that fails the run: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, or `INFO`
- `baseline` — baseline path, resolved relative to the config file; matching fingerprints are suppressed

Unknown keys and invalid values are configuration errors. CLI flags `--fail-on`, `--baseline`, and `--write-baseline` override or bootstrap these settings. Baseline fingerprints use the rule, project-relative path, normalized source range, and message, so inserting unrelated lines or moving a checkout does not revive old findings. Changed vulnerable code is reported again.

### 6. Suppressing findings in-source

```tsx
// code-verifier-disable-next-line
await AsyncStorage.setItem('cache_blob', blob);
```

Also available: `// code-verifier-disable` (this + next line) and `// code-verifier-disable-file`.

## 🧠 How the analysis works

1. [src/parser/ast.ts](src/parser/ast.ts) — Babel parse (TS/TSX/JS/JSX, decorators, top-level await).
2. [src/engine.ts](src/engine.ts) — collects the module top level **plus every function body** as an independent CFG root.
3. [src/cfg/builder.ts](src/cfg/builder.ts) — CFG with if/else, while, do-while, `for` (init/test/update modeled), for-in/of, switch (fallthrough + break), try/catch/finally, break/continue/return/throw edges, and **labeled edge conditions** for path refinement.
4. [src/abstract-interpreter/fixpoint.ts](src/abstract-interpreter/fixpoint.ts) — worklist fixed-point with widening at loop headers, force-widening after repeated visits (guaranteed termination, per-node cap emits an INFO diagnostic instead of failing silently), lexical binding identity, bounded field-sensitive object paths, recursive expression taint, object/array destructuring, `useState<T | null>(...)`, and TS `as`/`!` wrappers.
5. [src/abstract-interpreter/function-summaries.ts](src/abstract-interpreter/function-summaries.ts) — bounded, compositional summaries for fixed returns, parameter and object-field passthrough, DOMPurify-backed sanitizers, and parameter-to-sink effects. A project fixed point propagates these facts through multiple local/imported wrapper layers, named/default/namespace imports, explicit/star re-exports, and TypeScript `baseUrl`/`paths` aliases, while remaining restricted to selected analysis files.
6. [src/abstract-interpreter/refine.ts](src/abstract-interpreter/refine.ts) — path-sensitive refinement along branch edges (`===`/`!==`/`==`/`!=` null checks, `typeof` guards, truthiness, optional-chain conditions, member-read bases, `&&`/`||`/`??`).
7. [src/abstract-interpreter/ts-types.ts](src/abstract-interpreter/ts-types.ts) — TypeScript annotation nullability seeds: parameters (`function f(u: User | null)`), annotated declarations (`const u: User | null = api.user` — fills gaps only, computed facts win), and `useState<T | null>()` type arguments.
8. [src/rules/](src/rules/) — the rule set; flow-based rules (`AI-NULL-001`, `AI-TAINT-001`) consume per-statement abstract states.
9. [src/semantic-analysis.ts](src/semantic-analysis.ts) — one shared TypeScript Program and TypeChecker for type-proven floating Promises and Promise-valued conditions.
10. [src/mobile-config.ts](src/mobile-config.ts) — bounded Expo `app.json`, Android manifest, and iOS plist checks, excluding generated and vendored native directories.
11. [src/native-consistency.ts](src/native-consistency.ts) — cross-checks JS imports against `ios/Podfile.lock` using each package's own podspec pod names, catching stale native builds before runtime.

## 🧪 Running Tests

```bash
npm test
```

306 tests: logic, async, compiler-backed Promise semantics, multi-layer interprocedural and object-field flows, Expo/native, IaC, and supply-chain configuration, backend/API correctness, persistent caching and scheduling, React/React Native correctness, React Native animation driver/latch and pan-responder capture rules, reliability, code-quality, CWE checks, bounded field sensitivity, recursive/destructured/callback taint propagation, lexical-shadowing regressions, TypeScript-annotation nullability seeding, path aliases, crash-proofing, completion status, registry coverage, baselines, stable SARIF fingerprints, suppressions, lattice tests, manifest-rule calibration regressions (launcher activities, scoped backup rules, debug overlays), Expo Router route and Podfile.lock native-consistency regressions, render-phase ref-access and unused-declaration (including nested-in-exported-component) regressions, React 19 upgrade regressions (removed ReactDOM APIs, createFactory, string refs, legacy context, function-component defaultProps, propTypes, useRef argument, use-in-try, ref-callback returns, test-utils, forwardRef), Fast Refresh mixed-exports regressions, and formatters.

`npm run benchmark` runs labeled vulnerable/fixed and mutation-style pairs, reports precision, recall, and F1, and fails below 95% precision or recall. The benchmark is a regression gate for its selected cases, not a claim of universal real-world accuracy.

## ⚠️ Honest limitations

- The 79 rules cover selected correctness, reliability, quality, framework, platform/deployment configuration, supply-chain, API, and CWE classes; they do not guarantee defect-free or secure software. Use this verifier alongside type checking, linting, tests, dependency scanning, platform tooling, and review.
- The transfer function models assignments of literals, identifiers, arithmetic, `await`, logicals, unary, and property reads. Unmodeled expressions become `Top` — **unknown values are never reported as null dereferences**, so precision is limited but reports are trustworthy.
- Taint sources/sinks remain a curated list; anything outside it (for example arbitrary `fetch` responses) is not automatically treated as tainted. Field paths, expression recursion, destructuring, standard collection callbacks, and parameter-to-return/sink summaries are bounded to keep scans terminating and findings explainable.
- Cross-file analysis follows relative ESM imports/re-exports and TypeScript `baseUrl`/`paths` mappings only when the resolved target is already in the analyzed file set. External packages, mutable module state, dynamic property names, and general interprocedural control flow are not modeled.
- Switch fallthrough analysis is approximate; labeled `break`/`continue` are treated as unlabeled.
- Framework rules intentionally recognize explicit, statically provable forms. WebView settings hidden in spread props, dynamically computed `postMessage` origins, TLS options assembled through aliases, and cleanup performed only through opaque helper functions may require project linting or manual review.
- Injection and resource rules trace explicit request, navigation, browser-location, and process-argument sources through constant local bindings and bounded expressions. Custom framework request objects, mutations, dynamically selected APIs, and sanitizer semantics outside modeled helpers require additional configuration or review.
- Compiler-backed Promise checks currently run for TypeScript/TSX source in CLI project scans. JavaScript remains syntax/abstract-analysis based unless a later phase enables project-specific `checkJs` semantics.
- Mobile configuration analysis targets explicit backup, cleartext/ATS, exported components, debuggable releases, document sharing, and a narrow high-risk permission set in Expo JSON, Android manifests, and iOS plists; it is not a complete MASVS or store-policy audit.
- Kubernetes and Terraform checks intentionally cover explicit high-confidence privilege and public administrative-ingress settings. They do not replace schema validation, policy-as-code, cloud-provider analysis, or runtime posture management.
