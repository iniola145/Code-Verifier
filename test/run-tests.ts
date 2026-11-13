import { CodeVerifier } from "../src/engine";
import { LLMFormatter } from "../src/formatter/llm-formatter";
import { formatSARIF } from "../src/formatter/sarif";
import { ALL_RULES } from "../src/rules/react-native-rules";
import { RULE_REGISTRY, validateRuleRegistry } from "../src/rules/registry";
import {
  classifyESLintExit,
  classifyNpmAuditExit,
  summarizeESLintOutput,
  summarizeNpmAuditOutput,
} from "../src/project-checks";
import { ProjectSummaryIndex } from "../src/abstract-interpreter/project-summaries";
import * as path from "path";
import {
  IntervalDomain,
  MemoryState,
  NullabilityDomain,
} from "../src/abstract-interpreter/domain";
import { MemoryAbstractState } from "../src/types/verifier";
import {
  diagnosticFingerprint,
  loadBaseline,
  writeBaseline,
} from "../src/baseline";
import { loadConfig } from "../src/config";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";
import { SemanticAnalysisIndex } from "../src/semantic-analysis";
import { ImportGraphIndex } from "../src/unused-files";
import { ProjectUiIndex } from "../src/project-ui-index";
import {
  AsyncPatternStrategy,
  detectFramework,
  generateMockCode,
  generateTests,
  generateTestsForFile,
  RaceConditionStrategy,
  synthesizeMocks,
} from "../src/test-gen";
import {
  parseTraceContent,
  parseTraceFile,
  parseJestOutput,
  parseJunitOutput,
  analyzeRuntimeTraces,
  formatRuntimeFindings,
  formatTDRSession,
  formatFixVerification,
  createSession,
  loadSession,
  saveSession,
  listSessions,
  updateSession,
  deleteSession,
  setSessionDir,
  pruneSessions,
  cleanAllSessions,
  findExistingTestFile,
  verifyFix,
  Diagnostic,
  generateProbe,
  RUNTIME_PREAMBLE_CODE,
  generateRuntimePreamble,
  instrumentCode,
  instrumentFile,
  codeVerifierInstrumentPlugin,
  startUITestSession,
  stopUITestSession,
  getUITestSession,
  clearUITestSessions,
  createPlaywrightDriver,
  createDetoxDriver,
  SimulatedUIDriver,
  observeUI,
  buildObservationPrompt,
  parseObservationResponse,
  generateBugReport,
  UITestSession,
  UIBug,
  UISTep,
  UIDriver,
} from "../src";
import CodeVerifierReporter from "../src/adapters/jest-reporter";
import codeVerifierPlugin from "../src/adapters/vitest-plugin";
import { parseSourceCode } from "../src/parser/ast";

/** Recursively collects source files under dir, skipping node_modules/dist/.git. */
function expandAllFiles(dir: string): string[] {
  const skip = new Set(["node_modules", "dist", ".git"]);
  const out: string[] = [];
  const walk = (p: string): void => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      if (entry.isDirectory() && skip.has(entry.name)) continue;
      const child = path.join(p, entry.name);
      if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name))
        out.push(child);
      else if (entry.isDirectory()) walk(child);
    }
  };
  walk(dir);
  return out;
}
import { verifyMobileConfigs } from "../src/mobile-config";
import { verifyDeploymentConfigs } from "../src/deployment-config";
import { verifyNativeConsistency } from "../src/native-consistency";
import {
  fileCacheKey,
  mapWithConcurrency,
  projectSignature,
  ScanCache,
} from "../src/scan-cache";

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passedCount++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    if (detail) console.error(`     ${detail}`);
    failedCount++;
  }
}

const verifier = new CodeVerifier();

/** Expects at least one diagnostic with the given rule id. */
async function expectFinding(code: string, ruleId: string, label: string) {
  const res = await verifier.verifyCode(code, `${label}.tsx`);
  const has = res.diagnostics.some((d) => d.ruleId === ruleId);
  assert(
    has,
    label,
    `expected ${ruleId}, got [${res.diagnostics.map((d) => d.ruleId).join(", ") || "none"}]`,
  );
}

/** Expects verification to pass with zero blocking issues. */
async function expectClean(code: string, label: string) {
  const res = await verifier.verifyCode(code, `${label}.tsx`);
  const blocking = res.diagnostics.filter((d) => d.severity !== "INFO");
  assert(
    res.passed,
    label,
    `expected clean, got: ${blocking.map((d) => `${d.ruleId}@L${d.loc.start.line}`).join(", ") || "none"}`,
  );
}

async function expectNoFinding(code: string, ruleId: string, label: string) {
  const res = await verifier.verifyCode(code, `${label}.tsx`);
  assert(
    !res.diagnostics.some((d) => d.ruleId === ruleId),
    label,
    `expected no ${ruleId}, got [${res.diagnostics.map((d) => d.ruleId).join(", ") || "none"}]`,
  );
}

async function runTests() {
  console.log("🧪 Running Code Verifier Test Suite...\n");

  console.log("— SAST Rules: Detection");
  await expectFinding(
    `
    export async function saveAuth(token: string) {
      await AsyncStorage.setItem('auth_token', token);
    }
  `,
    "RN-SEC-001",
    "Detects insecure AsyncStorage usage for auth_token",
  );

  await expectFinding(
    `
    export function Article({ userContent }: { userContent: string }) {
      return <WebView source={{ html: userContent }} />;
    }
  `,
    "RN-SEC-002",
    "Detects dynamic HTML injection into WebView",
  );

  await expectFinding(
    `
    export function Screen({ src }: { src: string }) {
      return <WebView injectedJavaScript={src} />;
    }
  `,
    "RN-SEC-002",
    "Detects dynamic injectedJavaScript in WebView",
  );

  await expectFinding(
    `
    export function Counter() {
      const [count, setCount] = useState(0);
      useEffect(() => { setCount(count + 1); });
      return <div>{count}</div>;
    }
  `,
    "REACT-001",
    "Detects infinite re-render loop in useEffect",
  );

  await expectFinding(
    `
    export function Profile({ isVip }: { isVip: boolean }) {
      if (isVip) { const [discount] = useState(20); }
      return <div>Profile</div>;
    }
  `,
    "REACT-002",
    "Detects conditional React Hook call",
  );

  await expectFinding(
    `
    export function Profile({ isVip }: { isVip: boolean }) {
      isVip && useState(20);
      return <div>Profile</div>;
    }
  `,
    "REACT-002",
    "Detects hook call behind logical AND",
  );

  await expectFinding(
    `
    const API_KEY = "sk_live_938491823091823091823091";
    export function fetchPay() {}
  `,
    "SEC-003",
    "Detects hardcoded Stripe live key",
  );

  await expectFinding(
    `
    const token = "ghp_9aQbRcSdTeUfVgWhXiJyKzLmNoPqRsTuVw";
    export function fetch() {}
  `,
    "SEC-003",
    "Detects hardcoded GitHub PAT",
  );

  await expectFinding(
    `
    const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
    export function s3() {}
  `,
    "SEC-003",
    "Detects hardcoded AWS access key",
  );

  await expectFinding(
    `
    const cfg = { apiKey: "sk_test_938491823091823091823" };
    export function pay() {}
  `,
    "SEC-003",
    "Detects secret in object literal",
  );

  {
    // vbook regression: sample JWT inside tests/e2e/helpers/coldStartFixtures.ts.
    // Test files are excluded from the shipped client bundle, so this rule's
    // extraction-exposure rationale does not apply in test scope.
    const jwtFixture = `export const JWT_FIXTURE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmaXh0dXJlIn0.coldStartSample";`;
    const fixtureRes = await new CodeVerifier().verifyCode(
      jwtFixture,
      "tests/e2e/helpers/coldStartFixtures.ts",
    );
    assert(
      !fixtureRes.diagnostics.some((d) => d.ruleId === "SEC-003"),
      "Secrets inside test fixture files are exempt",
      fixtureRes.diagnostics.map((d) => d.ruleId).join(", "),
    );
    const bundledRes = await new CodeVerifier().verifyCode(
      jwtFixture,
      "src/features/auth/apiClient.ts",
    );
    assert(
      bundledRes.diagnostics.some((d) => d.ruleId === "SEC-003"),
      "SEC-003 still flags the same secret outside test scope",
    );
  }

  await expectFinding(
    `
    function run() { eval(userInput); }
  `,
    "SEC-004",
    "Detects eval() usage",
  );

  await expectFinding(
    `
    function run() { new Function('return 1')(); }
  `,
    "SEC-004",
    "Detects new Function() usage",
  );

  await expectFinding(
    `
    export function Article({ body }: any) {
      return <div dangerouslySetInnerHTML={{ __html: body }} />;
    }
  `,
    "SEC-005",
    "Detects dynamic dangerouslySetInnerHTML",
  );

  await expectClean(
    `
    import DOMPurify from 'dompurify';
    export function Article({ body }: any) {
      return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body) }} />;
    }
  `,
    "Clean: DOMPurify-sanitized inner HTML",
  );

  await expectClean(
    `
    import { sanitizeHtml } from './lib/sanitize';
    export function Article({ body }: any) {
      return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(body) || 'No content' }} />;
    }
  `,
    "Clean: sanitizer wrapper with import provenance",
  );

  await expectFinding(
    `
    import { sanitizeHtml } from './lib/sanitize';
    export function Article({ body, fallback }: any) {
      return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(body) || fallback }} />;
    }
  `,
    "SEC-005",
    "Detects unsanitized dynamic fallback branch",
  );

  await expectFinding(
    `
    function sanitizeHtml(value: string) { return value; }
    export function Article({ body }: any) {
      return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(body) }} />;
    }
  `,
    "SEC-005",
    "Does not trust an arbitrary local sanitizer name",
  );

  await expectFinding(
    `
    export function save(token: string) {
      localStorage.setItem('auth_token', token);
    }
  `,
    "SEC-006",
    "Detects token in web localStorage",
  );

  await expectFinding(
    `
    export function Browser() {
      return <WebView source={{ uri: 'https://example.com' }} allowUniversalAccessFromFileURLs />;
    }
  `,
    "RN-SEC-003",
    "Detects universal WebView file access",
  );
  await expectFinding(
    `<WebView source={{ uri }} mixedContentMode="always" />`,
    "RN-SEC-003",
    "Detects always-allow WebView mixed content",
  );
  await expectNoFinding(
    `<WebView source={{ uri }} allowUniversalAccessFromFileURLs={false} mixedContentMode="never" />`,
    "RN-SEC-003",
    "Secure WebView settings are clean",
  );
  await expectNoFinding(
    `<WebView source={{ html: '<p>safe</p>' }} originWhitelist={['*']} />`,
    "RN-SEC-003",
    "Required static-HTML origin whitelist is not misclassified",
  );

  await expectFinding(
    `frame.contentWindow.postMessage(payload, '*');`,
    "WEB-002",
    "Detects wildcard browser postMessage origin",
  );
  await expectNoFinding(
    `frame.contentWindow.postMessage(payload, 'https://trusted.example');`,
    "WEB-002",
    "Exact postMessage origin is clean",
  );
  await expectNoFinding(
    `webViewRef.current.postMessage(payload);`,
    "WEB-002",
    "React Native WebView one-argument postMessage is clean",
  );

  await expectFinding(
    `const agent = new https.Agent({ rejectUnauthorized: false });`,
    "NET-002",
    "Detects disabled TLS certificate verification",
  );
  await expectFinding(
    `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';`,
    "NET-002",
    "Detects process-wide TLS verification override",
  );
  await expectNoFinding(
    `const agent = new https.Agent({ rejectUnauthorized: true });`,
    "NET-002",
    "Enabled TLS certificate verification is clean",
  );
  await expectNoFinding(
    `const display = { rejectUnauthorized: false };`,
    "NET-002",
    "Unrelated object property is not treated as TLS configuration",
  );

  await expectFinding(
    `
    function Clock() {
      useEffect(() => { const id = setInterval(tick, 1000); }, []);
      return null;
    }
  `,
    "REACT-003",
    "Detects interval created by effect without cleanup",
  );
  await expectFinding(
    `
    function Online() {
      useEffect(() => { window.addEventListener('online', refresh); }, []);
      return null;
    }
  `,
    "REACT-003",
    "Detects event listener created by effect without cleanup",
  );
  await expectNoFinding(
    `
    function Clock() {
      useEffect(() => {
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
      }, []);
      return null;
    }
  `,
    "REACT-003",
    "Effect interval with cleanup is clean",
  );
  await expectNoFinding(
    `
    function Online() {
      useEffect(() => { window.addEventListener('online', refresh, { once: true }); }, []);
      return null;
    }
  `,
    "REACT-003",
    "One-shot effect listener does not require explicit cleanup",
  );

  await expectFinding(
    `function run(req: any) { const command = ` +
      "`ls ${req.query.dir}`" +
      `; exec(command); }`,
    "SEC-007",
    "Detects request input in shell command",
  );
  await expectNoFinding(
    `exec('npm run build');`,
    "SEC-007",
    "Static shell command is clean",
  );

  await expectFinding(
    `function find(req: any) { const sql = ` +
      "`SELECT * FROM users WHERE id = ${req.params.id}`" +
      `; db.query(sql); }`,
    "SEC-008",
    "Detects request input interpolated into SQL",
  );
  await expectNoFinding(
    `db.query('SELECT * FROM users WHERE id = ?', [userId]);`,
    "SEC-008",
    "Parameterized SQL is clean",
  );

  await expectFinding(
    `async function proxy(req: any) { return fetch(req.query.url); }`,
    "SEC-009",
    "Detects request-controlled outbound URL",
  );
  await expectNoFinding(
    `fetch('https://api.example.com/status');`,
    "SEC-009",
    "Static outbound URL is clean",
  );

  await expectFinding(
    `function download(req: any) { return fs.readFile(req.params.path, done); }`,
    "SEC-010",
    "Detects request-controlled filesystem path",
  );
  await expectNoFinding(
    `fs.readFile('/srv/app/config.json', done);`,
    "SEC-010",
    "Static filesystem path is clean",
  );

  await expectFinding(
    `function generatePassword() { return Math.random().toString(36); }`,
    "SEC-011",
    "Detects weak random password generation",
  );
  await expectFinding(
    `function hashPassword(value: string) { return crypto.createHash('sha1').update(value).digest('hex'); }`,
    "SEC-011",
    "Detects weak hash in password context",
  );
  await expectNoFinding(
    `function randomColor() { return Math.random(); }`,
    "SEC-011",
    "Non-security random value is clean",
  );

  await expectFinding(
    `function merge(req: any, target: any) { const key = req.body.key; target[key] = req.body.value; }`,
    "SEC-012",
    "Detects request-controlled object key write",
  );
  await expectNoFinding(
    `target['displayName'] = value;`,
    "SEC-012",
    "Static object key write is clean",
  );

  await expectFinding(
    `function login(password: string) { console.log('login attempt', password); }`,
    "SEC-013",
    "Detects password written to console logs",
  );
  await expectFinding(
    `logger.info({ userId, accessToken });`,
    "SEC-013",
    "Detects token nested in structured logs",
  );
  await expectNoFinding(
    `logger.info({ userId, event: 'login-success' });`,
    "SEC-013",
    "Non-sensitive authentication event logging is clean",
  );
  await expectNoFinding(
    `console.log('password validation failed');`,
    "SEC-013",
    "Sensitive words in static log messages are not treated as leaked values",
  );

  await expectFinding(
    `function authenticate(token: string) { return jwt.decode(token); }`,
    "SEC-014",
    "Detects authentication JWT decoded without verification",
  );
  await expectFinding(
    `function middleware(req: any) { return jwt.decode(req.headers.authorization); }`,
    "SEC-014",
    "Detects request JWT decoded without verification",
  );
  await expectNoFinding(
    `function authenticate(token: string) { return jwt.verify(token, publicKey, { algorithms: ['RS256'] }); }`,
    "SEC-014",
    "Verified JWT is clean",
  );
  await expectNoFinding(
    `function inspectFixture(value: string) { return jwt.decode(value); }`,
    "SEC-014",
    "Non-authentication JWT inspection is not assumed to establish trust",
  );

  await expectFinding(
    `async function create(req: any) { return User.create(req.body); }`,
    "SEC-015",
    "Detects direct request-body mass assignment",
  );
  await expectFinding(
    `async function update(req: any) { const changes = req.body; return User.updateOne({ id: req.params.id }, changes); }`,
    "SEC-015",
    "Detects aliased request-body mass assignment",
  );
  await expectFinding(
    `function patch(req: any, user: any) { Object.assign(user, { ...req.body }); }`,
    "SEC-015",
    "Detects spread request-body mass assignment",
  );
  await expectNoFinding(
    `async function create(req: any) { const dto = { name: req.body.name, email: req.body.email }; return User.create(dto); }`,
    "SEC-015",
    "Allowlisted persistence DTO is clean",
  );

  await expectFinding(
    `res.cookie('session', value);`,
    "SEC-016",
    "Detects session cookie without security attributes",
  );
  await expectFinding(
    `res.cookie('refresh_token', value, { secure: false, httpOnly: true, sameSite: 'none' });`,
    "SEC-016",
    "Detects explicitly insecure refresh cookie",
  );
  await expectNoFinding(
    `res.cookie('session', value, { secure: true, httpOnly: true, sameSite: 'strict' });`,
    "SEC-016",
    "Hardened session cookie is clean",
  );
  await expectNoFinding(
    `res.cookie('theme', 'dark');`,
    "SEC-016",
    "Non-sensitive preference cookie is clean",
  );

  await expectFinding(
    `app.use(cors({ origin: true, credentials: true }));`,
    "SEC-017",
    "Detects reflected origin with credentialed CORS",
  );
  await expectFinding(
    `app.use(cors({ origin: '*', credentials: true }));`,
    "SEC-017",
    "Detects wildcard origin with credentialed CORS",
  );
  await expectNoFinding(
    `app.use(cors({ origin: 'https://app.example.com', credentials: true }));`,
    "SEC-017",
    "Exact credentialed CORS origin is clean",
  );
  await expectNoFinding(
    `app.use(cors({ origin: '*', credentials: false }));`,
    "SEC-017",
    "Public non-credentialed CORS is not misclassified",
  );

  console.log("— Logic and Async Correctness");
  await expectFinding(
    `let ready = false; if (ready = initialize()) start();`,
    "LOGIC-001",
    "Detects assignment used as an if condition",
  );
  await expectNoFinding(
    `let ready = false; ready = initialize(); if (ready === true) start();`,
    "LOGIC-001",
    "Separated assignment and comparison are clean",
  );
  await expectFinding(
    `const names = users.map(user => { user.name; });`,
    "LOGIC-002",
    "Detects map callback with missing return",
  );
  await expectFinding(
    `const active = users.filter(user => { check(user); });`,
    "LOGIC-002",
    "Detects filter callback with missing return",
  );
  await expectNoFinding(
    `const names = users.map(user => { return user.name; });`,
    "LOGIC-002",
    "Returning map callback is clean",
  );
  await expectNoFinding(
    `users.forEach(user => { notify(user); });`,
    "LOGIC-002",
    "Side-effecting forEach callback does not require a return",
  );
  await expectFinding(
    `async function saveAll(items: Item[]) { items.forEach(async item => { await save(item); }); }`,
    "ASYNC-001",
    "Detects async forEach callback",
  );
  await expectNoFinding(
    `async function saveAll(items: Item[]) { await Promise.all(items.map(async item => save(item))); }`,
    "ASYNC-001",
    "Awaited Promise.all map is clean",
  );
  await expectFinding(
    `const task = new Promise(async resolve => { resolve(await load()); });`,
    "ASYNC-002",
    "Detects async Promise executor",
  );
  await expectNoFinding(
    `const task = new Promise((resolve, reject) => { load().then(resolve, reject); });`,
    "ASYNC-002",
    "Synchronous Promise executor is clean",
  );

  console.log("— React and React Native Correctness");
  await expectFinding(
    `function Screen() { useEffect(async () => { await load(); }, []); return null; }`,
    "REACT-004",
    "Detects async useEffect setup",
  );
  await expectNoFinding(
    `function Screen() { useEffect(() => { async function run() { await load(); } run(); }, []); return null; }`,
    "REACT-004",
    "Inner async Effect operation is clean",
  );
  await expectFinding(
    `function List({ items }) { return items.map((item, index) => <Row key={index} item={item} />); }`,
    "REACT-005",
    "Detects array index used as React key",
  );
  await expectNoFinding(
    `function List({ items }) { return items.map(item => <Row key={item.id} item={item} />); }`,
    "REACT-005",
    "Stable React item key is clean",
  );
  await expectFinding(
    `function Counter() { const [count, setCount] = useState(0); useEffect(() => { const id = setInterval(() => setCount(count + 1), 1000); return () => clearInterval(id); }, []); return count; }`,
    "REACT-006",
    "Detects stale state captured by Effect timer",
  );
  await expectNoFinding(
    `function Counter() { const [count, setCount] = useState(0); useEffect(() => { const id = setInterval(() => setCount(current => current + 1), 1000); return () => clearInterval(id); }, []); return count; }`,
    "REACT-006",
    "Functional timer state update is clean",
  );
  await expectFinding(
    `function RideMap() { const pulse = useRef(new Animated.Value(1)).current; useEffect(() => { pulse.addListener(() => {}); }, [pulse]); return null; }`,
    "REACT-007",
    "Detects useRef(...).current read at render top level",
  );
  await expectFinding(
    `function Screen() { const rows = useRef(null); if (rows.current) return <View />; return null; }`,
    "REACT-007",
    "Detects ref.current read in a render branch",
  );
  await expectNoFinding(
    `function Screen() { const rows = useRef(null); useEffect(() => { if (rows.current) scroll(); }, []); return <Pressable onPress={() => rows.current?.focus()} />; }`,
    "REACT-007",
    "Effect and event-handler ref access is clean",
  );
  await expectNoFinding(
    `function Screen() { const box = { current: 5 }; return <Text>{box.current}</Text>; }`,
    "REACT-007",
    "Plain object current field is not treated as a ref",
  );
  await expectFinding(
    `function RideView() { const [pickup, setPickup] = useState(DEFAULT_PICKUP); return null; }`,
    "REACT-008",
    "Detects useState value that is never read",
  );
  await expectFinding(
    `function RideView() { const [pickup, setPickup] = useState(DEFAULT_PICKUP); return <Text>{pickup.name}</Text>; }`,
    "REACT-008",
    "Detects state whose setter is never called",
  );
  await expectNoFinding(
    `export function RideView() { const [pickup, setPickup] = useState(DEFAULT_PICKUP); useEffect(() => setPickup(place), [place]); return <Text>{pickup.name}</Text>; }`,
    "HYG-002",
    "State value read in JSX and setter called — both rules stay quiet",
  );
  await expectNoFinding(
    `function RideView() { const [_draft] = useState(null); return null; }`,
    "REACT-008",
    "Underscore-prefixed state is treated as intentionally unused",
  );
  await expectFinding(
    `function save() { const leftover = compute(); return 1; }`,
    "HYG-002",
    "Detects unused local declaration",
  );
  await expectFinding(
    `function save() { let total; total = compute(); return 1; }`,
    "HYG-002",
    "Detects variable assigned but never read",
  );
  await expectNoFinding(
    `export const MAX = 5; export function useThing() { return MAX; }`,
    "HYG-002",
    "Exported declarations are exempt",
  );
  await expectFinding(
    `export const Screen: any = () => { const handleExit = useCallback(() => {}, []); return null; }`,
    "HYG-002",
    "Detects unused callback nested inside an exported component",
  );
  await expectFinding(
    `export const Screen: any = () => { function deadHelper() { return 1; } return null; }`,
    "HYG-002",
    "Detects dead nested helper inside an exported component",
  );
  await expectNoFinding(
    `export const Screen: any = () => { const handleExit = useCallback(() => {}, []); return <Pressable onPress={handleExit} />; }`,
    "HYG-002",
    "Handler referenced from JSX is used",
  );
  await expectFinding(
    `import * as ReactDOM from "react-dom"; export function boot(el: any) { ReactDOM.render(<div />, el); }`,
    "REACT-009",
    "Detects ReactDOM.render through a namespace import",
  );
  await expectFinding(
    `import { render } from "react-dom"; export function boot(el: any) { render(<div />, el); }`,
    "REACT-009",
    "Detects a named render import from react-dom",
  );
  await expectFinding(
    `import * as ReactDOMServer from "react-dom/server"; export function stream(app: any) { return ReactDOMServer.renderToNodeStream(app); }`,
    "REACT-009",
    "Detects removed react-dom/server node-stream renderer",
  );
  await expectNoFinding(
    `import { createRoot } from "react-dom/client"; export function boot(el: any) { createRoot(el).render(<div />); }`,
    "REACT-009",
    "react-dom/client createRoot is clean",
  );
  await expectFinding(
    `import * as React from "react"; export function makeButton() { return React.createFactory("button"); }`,
    "REACT-010",
    "Detects React.createFactory call",
  );
  await expectFinding(
    `export function Form() { return <input ref="emailInput" />; }`,
    "REACT-011",
    "Detects string ref on a JSX element",
  );
  await expectNoFinding(
    `export function Form() { const emailRef = useRef(null); return <input ref={emailRef} />; }`,
    "REACT-011",
    "Ref object is clean",
  );
  await expectFinding(
    `class Nav extends React.Component { static contextTypes = { theme: () => {} }; getChildContext() { return { theme: "dark" }; } render() { return null; } }`,
    "REACT-012",
    "Detects legacy context members on a class component",
  );
  await expectNoFinding(
    `class Nav extends React.Component { static contextType = ThemeContext; render() { return null; } }`,
    "REACT-012",
    "Modern static contextType is clean",
  );
  await expectFinding(
    `const SizeButton = (props: any) => null; SizeButton.defaultProps = { size: 1 }; export { SizeButton };`,
    "REACT-013",
    "Detects defaultProps on a function component",
  );
  await expectNoFinding(
    `class Card extends React.Component { render() { return null; } } Card.defaultProps = { size: 1 };`,
    "REACT-013",
    "defaultProps on a class component is still supported and stays quiet",
  );
  await expectNoFinding(
    `function SizeButton({ size = 1 }: any) { return null; }`,
    "REACT-013",
    "Default parameters are the clean replacement",
  );
  await expectFinding(
    `const Badge = () => null; Badge.propTypes = { count: count }; export { Badge };`,
    "REACT-014",
    "Detects propTypes assigned on a component",
  );
  await expectFinding(
    `function Screen() { const marker = useRef(); return null; }`,
    "REACT-015",
    "Detects useRef() called without an initial value",
  );
  await expectNoFinding(
    `function Screen() { const marker = useRef(null); return null; }`,
    "REACT-015",
    "useRef(null) is clean",
  );
  await expectFinding(
    `import { use } from "react"; export function C({ promise }: any) { try { return use(promise); } catch { return null; } }`,
    "REACT-016",
    "Detects use() inside a try clause",
  );
  await expectNoFinding(
    `import { use } from "react"; export function C({ promise }: any) { const data = use(promise); return null; }`,
    "REACT-016",
    "use() outside try/catch is clean",
  );
  await expectFinding(
    `let instance: any; export function Screen() { return <input ref={(el: any) => (instance = el)} />; }`,
    "REACT-017",
    "Detects implicit-return callback ref",
  );
  await expectNoFinding(
    `let instance: any; export function Screen() { return <input ref={(el: any) => { instance = el; }} />; }`,
    "REACT-017",
    "Block-body callback ref is clean",
  );
  await expectNoFinding(
    `export function Screen() { return <input ref={(el: any) => el.focus()} />; }`,
    "REACT-017",
    "Void-returning call in a callback ref is clean",
  );
  await expectFinding(
    `import { isElement } from "react-dom/test-utils";`,
    "REACT-018",
    "Detects removed react-dom/test-utils import",
  );
  await expectFinding(
    `import { forwardRef } from "react"; export const FancyButton = forwardRef((props: any, ref: any) => <button ref={ref} {...props} />);`,
    "REACT-019",
    "Advisory: forwardRef wrapper no longer needed in React 19",
  );
  await expectFinding(
    `const PlaceholderScreen = ({ title }: { title: string }) => <div>{title}</div>; export const appRoutes: { path: string } = { path: "/", element: <PlaceholderScreen title="Hi" /> };`,
    "REACT-020",
    "Detects a component defined alongside a non-component export (route table)",
  );
  await expectFinding(
    `const routes = {}; export const Page = () => <div />; export { routes };`,
    "REACT-020",
    "Detects a re-exported non-component specifier beside a component",
  );
  await expectFinding(
    `export const Page = () => <div />; export default { config: true };`,
    "REACT-020",
    "Detects a non-component default export beside a component",
  );
  await expectNoFinding(
    `export const Header = () => <div>hi</div>;`,
    "REACT-020",
    "A file exporting only components is clean",
  );
  await expectNoFinding(
    `export const VERSION = "1.2.0"; export const Badge = () => <span>{VERSION}</span>;`,
    "REACT-020",
    "Primitive constant exports are allowed beside components (allowConstantExport)",
  );
  await expectNoFinding(
    `export const appRoutes = { path: "/", children: [] };`,
    "REACT-020",
    "A data module with no component definitions is clean",
  );
  await expectNoFinding(
    `export const usePageTitle = (t: string) => {}; export const Page = () => <div />;`,
    "REACT-020",
    "Hook exports are allowed beside components",
  );
  await expectNoFinding(
    `export type RouteKind = "app" | "auth"; export const Page = () => <div />;`,
    "REACT-020",
    "Type exports are allowed beside components",
  );
  await expectNoFinding(
    `const router = { routes: [<div />] }; export const AppRouter = () => <div>{router.routes}</div>;`,
    "REACT-020",
    "Module-level non-exported values beside a single component export are clean",
  );
  await expectFinding(
    `function Feed({ items }) { return <FlatList data={items} keyExtractor={(item, index) => String(index)} renderItem={renderItem} />; }`,
    "RN-COR-001",
    "Detects FlatList index key extractor",
  );
  await expectNoFinding(
    `function Feed({ items }) { return <FlatList data={items} keyExtractor={item => item.id} renderItem={renderItem} />; }`,
    "RN-COR-001",
    "Stable FlatList key extractor is clean",
  );
  await expectFinding(
    `
    import { Animated } from 'react-native';
    export function animate(fade: Animated.Value, slide: Animated.Value) {
      Animated.parallel([
        Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(slide, { toValue: 600, duration: 250, useNativeDriver: false }),
      ]).start();
    }
  `,
    "RN-COR-002",
    "Detects mixed useNativeDriver inside Animated.parallel",
  );
  await expectFinding(
    `
    import { Animated } from 'react-native';
    export function play(value: Animated.Value) {
      const fade = Animated.timing(value, { toValue: 1, duration: 200, useNativeDriver: true });
      Animated.sequence([fade, Animated.spring(value, { toValue: 0, useNativeDriver: false })]).start();
    }
  `,
    "RN-COR-002",
    "Detects mixed drivers through named animation variables in sequence",
  );
  await expectClean(
    `
    import { Animated } from 'react-native';
    export function animate(fade: Animated.Value, slide: Animated.Value) {
      Animated.parallel([
        Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: false }),
        Animated.timing(slide, { toValue: 600, duration: 250, useNativeDriver: false }),
      ]).start();
    }
  `,
    "Uniform JS-driven Animated.parallel is clean",
  );
  await expectNoFinding(
    `
    import { Animated } from 'react-native';
    export function animate(fade: Animated.Value, slide: Animated.Value, native: boolean) {
      Animated.parallel([
        Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: native }),
        Animated.timing(slide, { toValue: 600, duration: 250, useNativeDriver: false }),
      ]).start();
    }
  `,
    "RN-COR-002",
    "Non-literal useNativeDriver value is not reported",
  );
  await expectFinding(
    `
    import { useRef } from 'react';
    export function useSheet(onClose: () => void) {
      const busy = useRef(false);
      const runDismiss = () => {
        if (busy.current) return;
        busy.current = true;
        animation.start(({ finished }) => {
          if (!finished) return;
          busy.current = false;
          onClose();
        });
      };
      return runDismiss;
    }
  `,
    "RN-COR-003",
    "Detects animation latch cleared only on the finished path",
  );
  await expectNoFinding(
    `
    import { useRef } from 'react';
    export function useSheet() {
      const busy = useRef(false);
      const run = () => {
        if (busy.current) return;
        busy.current = true;
        animation.start(({ finished }) => {
          if (!finished) { busy.current = false; return; }
          busy.current = false;
        });
      };
      return run;
    }
  `,
    "RN-COR-003",
    "Latch also cleared on the interruption path is clean",
  );
  await expectNoFinding(
    `
    import { useRef } from 'react';
    export function useSheet() {
      const busy = useRef(false);
      const run = () => {
        busy.current = true;
        animation.start(({ finished }) => {
          busy.current = false;
          if (!finished) return;
        });
      };
      return run;
    }
  `,
    "RN-COR-003",
    "Latch cleared before the finished check is clean",
  );
  await expectNoFinding(
    `
    import { useRef } from 'react';
    export function once(done: () => void) {
      const fired = useRef(false);
      const run = () => {
        if (fired.current) return;
        fired.current = true;
        animation.start(({ finished }) => {
          if (!finished) return;
          done();
        });
      };
      return run;
    }
  `,
    "RN-COR-003",
    "One-shot latch without any reset is not reported",
  );
  await expectNoFinding(
    `
    let busy = false;
    export function run() {
      if (busy) return;
      busy = true;
      animation.start(({ finished }) => {
        if (!finished) return;
        busy = false;
      });
    }
  `,
    "RN-COR-003",
    "Plain boolean flag is not reported as an animation latch",
  );
  await expectFinding(
    `
    import { PanResponder } from 'react-native';
    export const makeResponder = () => PanResponder.create({
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => false,
    });
  `,
    "RN-COR-004",
    "Detects constant-true capture-phase pan responder",
  );
  await expectNoFinding(
    `
    import { PanResponder } from 'react-native';
    export const makeResponder = () => PanResponder.create({
      onStartShouldSetPanResponderCapture: (_, gesture) => gesture.dy > 2,
    });
  `,
    "RN-COR-004",
    "Conditional capture-phase pan responder is clean",
  );

  console.log("— Reliability and Code Quality");
  await expectFinding(
    `try { await save(); } catch (error) {}`,
    "REL-001",
    "Detects empty catch block",
  );
  await expectNoFinding(
    `try { await save(); } catch (error) { logger.error(error); throw error; }`,
    "REL-001",
    "Handled and rethrown error is clean",
  );
  await expectNoFinding(
    `try { await vibrate(); } catch { /* graceful fallback on unsupported devices */ }`,
    "REL-001",
    "Documented best-effort catch is clean",
  );
  await expectNoFinding(
    `try { await mutation.mutateAsync(); } catch { /* Handled by mutation onError toast */ }`,
    "REL-001",
    "Catch delegated to an explicit mutation error handler is clean",
  );
  {
    const testCatchResult = await verifier.verifyCode(
      `try { await mutate(); } catch { // expected error from mutation\n}`,
      "src/hooks/useThing.test.ts",
    );
    assert(
      !testCatchResult.diagnostics.some((d) => d.ruleId === "REL-001"),
      "Commented expected-error catch in test file is clean",
    );
  }
  await expectFinding(
    `function value() { try { return compute(); } finally { return fallback; } }`,
    "REL-002",
    "Detects return that overrides completion in finally",
  );
  await expectNoFinding(
    `function value() { try { return compute(); } finally { cleanup(); } }`,
    "REL-002",
    "Cleanup-only finally is clean",
  );
  await expectFinding(
    `function value() { return 1; console.log('never'); }`,
    "LOGIC-003",
    "Detects unreachable statement after return",
  );
  await expectNoFinding(
    `function value(flag: boolean) { if (flag) return 1; console.log('reachable'); return 2; }`,
    "LOGIC-003",
    "Statement after conditional return remains reachable",
  );
  await expectFinding(
    `items.map(item => process(item));`,
    "QUAL-001",
    "Detects ignored map result",
  );
  await expectNoFinding(
    `const processed = items.map(item => process(item));`,
    "QUAL-001",
    "Consumed map result is clean",
  );

  console.log("— Backend and API Correctness");
  await expectFinding(
    `try { await load(); } catch (error) { res.status(500).json({ error: error.message }); }`,
    "API-001",
    "Detects raw exception detail returned to clients",
  );
  await expectNoFinding(
    `catch (error) { logger.error(error); res.status(500).json({ error: 'Internal error' }); }`,
    "API-001",
    "Generic public API error is clean",
  );
  await expectFinding(
    `res.status(200).json({ error: 'User not found' });`,
    "API-002",
    "Detects error payload with success status",
  );
  await expectNoFinding(
    `res.status(404).json({ error: 'User not found' });`,
    "API-002",
    "Error payload with failure status is clean",
  );
  await expectFinding(
    `function handler(req, res) { if (!req.user) { res.status(401).json({ error: 'Unauthorized' }); } res.json(secret); }`,
    "API-003",
    "Detects execution continuing after conditional response",
  );
  await expectNoFinding(
    `function handler(req, res) { if (!req.user) { return res.status(401).json({ error: 'Unauthorized' }); } res.json(secret); }`,
    "API-003",
    "Returned conditional response is clean",
  );
  await expectFinding(
    `app.get('/admin/users', (req, res) => res.json(users));`,
    "AUTH-001",
    "Detects admin route without middleware",
  );
  await expectNoFinding(
    `app.get('/admin/users', requireAuth, requireAdmin, (req, res) => res.json(users));`,
    "AUTH-001",
    "Admin route with authorization middleware is clean",
  );

  console.log("— Abstract Interpretation: Detection");
  await expectFinding(
    `
    function renderUser() {
      const user = null;
      user.name;
    }
  `,
    "AI-NULL-001",
    "Detects definite null dereference",
  );

  await expectFinding(
    `
    function helper(x: number) { return x; }
    const user = null;
    user.name;
  `,
    "AI-NULL-001",
    "Analyzes code after function declaration (unreachable-block fix)",
  );

  await expectFinding(
    `
    let user = getUser();
    user = null;
    user.name;
  `,
    "AI-NULL-001",
    "Tracks reassignment to null",
  );

  await expectFinding(
    `
    function f() {
      const user = { profile: null };
      return user.profile.name;
    }
  `,
    "AI-NULL-001",
    "Field-sensitive state detects nested null dereference",
  );

  await expectFinding(
    `
    function f() {
      const user = { profile: { name: 'safe' } };
      user.profile = null;
      return user.profile.name;
    }
  `,
    "AI-NULL-001",
    "Property assignment updates field nullability",
  );

  await expectNoFinding(
    `
    function f() {
      const user = { profile: null as { name: string } | null };
      user.profile = { name: 'safe' };
      return user.profile.name;
    }
  `,
    "AI-NULL-001",
    "Non-null property overwrite replaces stale field fact",
  );

  await expectFinding(
    `
    function f() {
      const user = { profile: null };
      const profile = user.profile;
      return profile.name;
    }
  `,
    "AI-NULL-001",
    "Field nullability propagates through a local alias",
  );

  {
    const res = await verifier.verifyCode(
      `
      function f() {
        const user: { name: string } | null = null;
        { const user = { name: 'safe' }; user.name; }
        user.name;
      }
    `,
      "lexical-null.ts",
    );
    const findings = res.diagnostics.filter((d) => d.ruleId === "AI-NULL-001");
    assert(
      findings.length === 1 && findings[0].loc.start.line === 5,
      "Lexical identity isolates an inner non-null shadow from the nullable outer binding",
    );
  }

  await expectNoFinding(
    `
    function f() {
      const user = null;
      { const user = { name: 'safe' }; user.name; }
    }
  `,
    "AI-NULL-001",
    "Inner shadow does not inherit outer nullability",
  );

  await expectFinding(
    `
    function missingUser() { return null; }
    const user = missingUser();
    user.name;
  `,
    "AI-NULL-001",
    "Nullability propagates from same-file function summary",
  );

  await expectNoFinding(
    `
    async function getUsers(): Promise<User[]> {
      try { const response = await api.get('/users'); return response.data; }
      catch (error) { handleError(error); }
    }
    async function load() {
      const users = await getUsers();
      return users.find(user => user.active);
    }
  `,
    "AI-NULL-001",
    "No summary is emitted for conditional return with implicit fallthrough",
  );

  console.log("— Taint Flow");
  await expectFinding(
    `
    function handler(route: any) {
      const url = route.params;
      AsyncStorage.setItem('cache', url);
    }
  `,
    "AI-TAINT-001",
    "Taint flow: navigation params into AsyncStorage",
  );

  await expectFinding(
    `
    function Screen() {
      const params = useLocalSearchParams();
      const html = params.body;
      return <WebView source={{ html }} />;
    }
  `,
    "AI-TAINT-001",
    "Taint flow: expo-router params into WebView",
  );

  await expectFinding(
    `
    function Screen() {
      const { html } = useLocalSearchParams();
      return <WebView source={{ html }} />;
    }
  `,
    "AI-TAINT-001",
    "Taint survives object destructuring from expo-router params",
  );

  await expectFinding(
    `
    function handler(route: any) {
      const { body: payload } = route.params;
      AsyncStorage.setItem('cache', payload);
    }
  `,
    "AI-TAINT-001",
    "Taint survives aliased destructuring from navigation params",
  );

  await expectFinding(
    `
    function handler(route: any) {
      const { nested: { payload } } = route.params;
      AsyncStorage.setItem('cache', payload);
    }
  `,
    "AI-TAINT-001",
    "Taint survives bounded nested destructuring",
  );

  await expectFinding(
    `
    function handler(route: any) {
      const state = { payload: 'safe' };
      state.payload = route.params.body;
      const payload = state.payload;
      AsyncStorage.setItem('cache', payload);
    }
  `,
    "AI-TAINT-001",
    "Field taint propagates through property writes and reads",
  );

  await expectFinding(
    `
    function handler(route: any) {
      const raw = route.params.body;
      const payload = ` +
      "`prefix:${raw}`" +
      `;
      AsyncStorage.setItem('cache', payload);
    }
  `,
    "AI-TAINT-001",
    "Taint survives template interpolation",
  );

  await expectFinding(
    `
    function handler(route: any, enabled: boolean) {
      const raw = route.params.body;
      const payload = enabled ? raw : 'fallback';
      AsyncStorage.setItem('cache', payload);
    }
  `,
    "AI-TAINT-001",
    "Taint survives conditional expressions",
  );

  await expectFinding(
    `
    function handler(route: any) {
      const raw = route.params.body;
      const payload = JSON.stringify({ raw });
      AsyncStorage.setItem('cache', payload);
    }
  `,
    "AI-TAINT-001",
    "Taint survives structured literals and JSON.stringify",
  );

  await expectFinding(
    `
    function identity<T>(value: T): T { return value; }
    function handler(route: any) {
      const raw = route.params.body;
      const forwarded = identity(raw);
      AsyncStorage.setItem('cache', forwarded);
    }
  `,
    "AI-TAINT-001",
    "Taint propagates through same-file parameter passthrough helper",
  );

  await expectFinding(
    `
    function persist(value: string) { AsyncStorage.setItem('cache', value); }
    function handler(route: any) {
      const raw = route.params.body;
      persist(raw);
    }
  `,
    "AI-TAINT-001",
    "Sink-effect summary detects tainted argument flow into helper",
  );

  await expectNoFinding(
    `
    function persist(value: string) { AsyncStorage.setItem('cache', value); }
    function handler() { persist('safe'); }
  `,
    "AI-TAINT-001",
    "Sink-effect summary ignores clean arguments",
  );

  await expectFinding(
    `
    function handler(route: any) {
      const values = [route.params.body];
      values.forEach(value => AsyncStorage.setItem('cache', value));
    }
  `,
    "AI-TAINT-001",
    "Taint flows from collection receiver into callback element sink",
  );

  await expectFinding(
    `
    function persist(value: string) { AsyncStorage.setItem('cache', value); }
    function handler(route: any) {
      const values = [route.params.body];
      values.map(value => persist(value));
    }
  `,
    "AI-TAINT-001",
    "Callback element taint reaches a summarized sink helper",
  );

  await expectNoFinding(
    `
    function handler() {
      const values = ['safe'];
      values.forEach(value => AsyncStorage.setItem('cache', value));
    }
  `,
    "AI-TAINT-001",
    "Clean collection callback does not produce taint finding",
  );

  await expectNoFinding(
    `
    function cleanHtml(value: string) { return DOMPurify.sanitize(value); }
    function Screen(route: any) {
      const raw = route.params.body;
      const clean = cleanHtml(raw);
      return <WebView source={{ html: clean }} />;
    }
  `,
    "AI-TAINT-001",
    "DOMPurify-backed same-file helper clears taint",
  );

  await expectNoFinding(
    `
    function handler(route: any) {
      const payload = route.params.body;
      { const payload = 'safe'; AsyncStorage.setItem('cache', payload); }
    }
  `,
    "AI-TAINT-001",
    "Inner shadow does not inherit outer taint",
  );

  await expectFinding(
    `
    function handler(route: any) {
      const payload = route.params.body;
      { const payload = 'safe'; AsyncStorage.setItem('cache', payload); }
      AsyncStorage.setItem('cache', payload);
    }
  `,
    "AI-TAINT-001",
    "Outer taint survives an inner clean shadow",
  );

  console.log("— False Positive Regressions (must stay clean)");
  await expectClean(
    `
    function f() {
      const opts = { timeout: 1000 };
      return opts.timeout;
    }
  `,
    "Clean: object literal property access",
  );

  await expectClean(
    `
    const n = 42;
    if (cond) { log(n); }
    n.toFixed(2);
  `,
    "Clean: provably non-null value after branch (join identity fix)",
  );

  await expectClean(
    `
    useEffect(() => {
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    });
  `,
    "Clean: setInterval is not a state setter",
  );

  await expectClean(
    `
    export function Theme() {
      AsyncStorage.setItem('theme_preference', 'dark');
    }
  `,
    "Clean: non-sensitive AsyncStorage key",
  );

  await expectClean(
    `
    export function Article() {
      return <WebView source={{ html: '<h1>Static</h1>' }} />;
    }
  `,
    "Clean: static WebView HTML string",
  );

  await expectClean(
    `
    export function Counter() {
      const [count, setCount] = useState(0);
      useEffect(() => { setCount(1); }, []);
      return <div>{count}</div>;
    }
  `,
    "Clean: setState inside effect WITH dependency array",
  );

  await expectClean(
    `
    function renderUser(user: any) {
      if (user !== null) {
        user.name;
      }
    }
  `,
    "Clean: null guard refines nullability (path-sensitive fix)",
  );

  await expectClean(
    `
    function renderUser(user: any) {
      if (user === null) return;
      user.name;
    }
  `,
    "Clean: early return on null refines else-path",
  );

  await expectClean(
    `
    function Profile({ isAdmin }: any) {
      const handler = () => { const [x] = useState(0); return x; };
      if (isAdmin) { log(handler); }
      return null;
    }
  `,
    "Clean: hook inside nested callback is a different scope",
  );

  await expectClean(
    `
    function renderUser(user: any) {
      return user?.name;
    }
  `,
    "Clean: optional chaining is not a dereference",
  );

  await expectClean(
    `
    export function Profile({ isVip }: { isVip: boolean }) {
      if (isVip) { log('vip'); }
      const [discount] = useState(20);
      return <div>{discount}</div>;
    }
  `,
    "Clean: hook after if statement (not inside)",
  );

  await expectClean(
    `
    function useFolderForm(control: any) {
      const scope = useWatch({ control, name: 'scope' }) || 'private';
      const people = useWatch({ control, name: 'people' }) ?? [];
      return { scope, people };
    }
  `,
    "Clean: fallback applied to hook result is not a conditional hook",
  );

  await expectFinding(
    `
    function useFolderForm(control: any, enabled: boolean) {
      const scope = enabled && useWatch({ control, name: 'scope' });
      return scope;
    }
  `,
    "REACT-002",
    "Detects hook in conditionally evaluated RHS",
  );

  await expectClean(
    `
    const AUTH_TOKEN_KEY = 'sabi_auth_access_token';
    const REFRESH_TOKEN_KEY = 'sabi_auth_refresh_token';
  `,
    "Clean: credential storage key names are not secret values",
  );

  await expectFinding(
    `
    const AUTH_TOKEN = 'ProdToken-8f73A91z!';
  `,
    "SEC-003",
    "Detects complex hardcoded credential by sensitive name",
  );

  await expectClean(
    `
    function Invoices() {
      const [selectedInvoice] = useState<Invoice | null>(null);
      return selectedInvoice && <Modal id={selectedInvoice.id} />;
    }
  `,
    "Clean: JSX logical guard refines nullable value",
  );

  await expectClean(
    `
    function Invoices() {
      const [selectedInvoice] = useState<Invoice | null>(null);
      return selectedInvoice
        ? <Modal id={selectedInvoice.id} />
        : <EmptyState />;
    }
  `,
    "Clean: JSX ternary branch refines nullable value",
  );

  await expectFinding(
    `
    function Invoices() {
      const [selectedInvoice] = useState<Invoice | null>(null);
      return <Modal id={selectedInvoice.id} />;
    }
  `,
    "AI-NULL-001",
    "Still detects unguarded nullable JSX access",
  );

  console.log("— Suppression Comments");
  {
    const res = await verifier.verifyCode(
      `
      const user = null;
      // code-verifier-disable-next-line
      user.name;
    `,
      "supp.ts",
    );
    assert(res.passed, "code-verifier-disable-next-line suppresses finding");
  }
  {
    const res = await verifier.verifyCode(
      `
      // code-verifier-disable-file
      const user = null;
      user.name;
    `,
      "supp-file.ts",
    );
    assert(res.passed, "code-verifier-disable-file suppresses whole file");
  }

  console.log("— Lattice Math (unit)");
  {
    // (TOP used implicitly by sanitize assertions below)
    const unit = IntervalDomain.constant(5);
    assert(
      IntervalDomain.toString(IntervalDomain.add(unit, unit)) === "[10, 10]",
      "Interval 5+5=[10,10]",
    );
    const inf = IntervalDomain.add(
      IntervalDomain.fromRange(5, Infinity),
      IntervalDomain.fromRange(-Infinity, 5),
    );
    assert(
      !Number.isNaN(inf.min) && !Number.isNaN(inf.max),
      "Infinity arithmetic does not produce NaN (sanitize fix)",
    );
    assert(
      IntervalDomain.isTop(
        IntervalDomain.add(
          IntervalDomain.fromRange(-Infinity, 1),
          IntervalDomain.fromRange(-1, Infinity),
        ),
      ),
      "[-∞]+[+∞] widens to Top",
    );
  }
  {
    // Join identity: empty map must not pollute known facts
    const known: MemoryAbstractState = new Map();
    MemoryState.set(known, "x", { nullability: "NonNull" });
    const joined = MemoryState.join(new Map(), known);
    assert(
      MemoryState.get(joined, "x").nullability === "NonNull",
      "join({}, s) preserves facts (⊥ identity fix)",
    );
    const widened = MemoryState.widen(new Map(), known);
    assert(
      MemoryState.get(widened, "x").nullability === "NonNull",
      "widen({}, s) preserves facts",
    );
  }
  {
    assert(
      NullabilityDomain.join("NonNull", "Null") === "Nullable",
      "NonNull ⊔ Null = Nullable",
    );
    assert(
      NullabilityDomain.join("Null", "Null") === "Null",
      "Null ⊔ Null = Null",
    );
    assert(NullabilityDomain.join("Top", "NonNull") === "Top", "Top absorbs");
    assert(
      !NullabilityDomain.isKnownPossiblyNull("Top"),
      "Top is NOT reported as known-possibly-null (FP fix)",
    );
  }

  console.log("— End-to-End");
  {
    const code = `
      import React, { useState, useEffect } from 'react';
      import * as SecureStore from 'expo-secure-store';
      import { View, Text } from 'react-native';

      export function CleanComponent() {
        const [data, setData] = useState<string | null>(null);

        useEffect(() => {
          async function load() {
            const token = await SecureStore.getItemAsync('auth_token');
            setData(token);
          }
          load();
        }, []);

        return (
          <View>
            <Text>{data ?? 'Loading...'}</Text>
          </View>
        );
      }
    `;
    const res = await verifier.verifyCode(code, "CleanComponent.tsx");
    assert(
      res.passed,
      "Clean React Native / Expo component passes with 0 issues",
    );
    assert(
      (res.stats.functionsAnalyzed ?? 0) >= 2,
      "Stats report multiple analyzed functions",
    );
  }
  {
    const res = await verifier.verifyCode(
      `
      const user = null;
      user.name;
    `,
      "fmt.ts",
    );
    const md = LLMFormatter.formatForLLMPrompt(res);
    assert(
      md.includes("AI-NULL-001") && md.includes("Nullability"),
      "LLM formatter includes rule id and invariants",
    );
  }

  console.log("— TypeScript-Seed Nullability (new precision pass)");
  await expectFinding(
    `function greet(u: { name: string } | null) { return u.name; }`,
    "AI-NULL-001",
    "Nullable param deref is flagged",
  );
  await expectClean(
    `function greet(u: { name: string } | null) { if (!u) return null; return u.name; }`,
    "Guarded nullable param is clean",
  );
  await expectFinding(
    `function f(api: any) { const u: { a: number } | null = api.user; return u.a; }`,
    "AI-NULL-001",
    "Annotated const from unmodeled value is flagged",
  );
  await expectClean(
    `function f(api: any) { const u: { a: number } | null = api.user; if (!u) return null; return u.a; }`,
    "Guarded annotated const is clean",
  );
  await expectClean(
    `function f(u: { a: number } | null) { return u!.a; }`,
    "Non-null assertion is trusted",
  );
  await expectClean(
    `function f(u: { a: number } | null) { const v = u ?? { a: 1 }; return v.a; }`,
    "Nullish coalesce fallback is clean",
  );
  await expectClean(
    `function f(u: { a: number } | null) { const v = u || ({ a: 1 } as any); return v.a; }`,
    "OR with non-null fallback is clean",
  );
  await expectClean(
    `function f(u: { a: number } | null) { if (u != null) return u.a; return 0; }`,
    "Loose != null guard is clean",
  );
  await expectClean(
    `function f(u: { a: number } | null) { if (typeof u === 'undefined') return 0; return u.a; }`,
    "typeof-undefined guard is clean",
  );
  await expectClean(
    `function f(u: { p: string } | null) { if (u?.p) return u.p.length; return 0; }`,
    "Optional-chain condition proves non-null base",
  );
  await expectClean(
    `function f(attempt?: { kind: string; id: string } | null) { if (attempt?.kind === 'ready') return attempt.id; return ''; }`,
    "Successful optional-chain equality proves non-null base",
  );
  await expectClean(
    `function f(u: { p: string } | null) { if (u.p) return u.p.length; return 0; }`,
    "Member condition proves base non-null",
  );
  await expectClean(
    `function format(score: number | null | undefined) {
    if (typeof score !== 'number') return '-';
    return score.toFixed(2);
  }`,
    "typeof-number early return proves surviving value non-null",
  );
  await expectClean(
    `function branchId(selectedBranch: { id: string } | null) {
      return typeof selectedBranch?.id === 'string' ? selectedBranch.id : '';
    }`,
    "Optional-chain typeof guard proves the object non-null in the true branch",
  );
  await expectFinding(
    `function C() {
  const [user] = useState<User | null>(null);
  return <Text>{user.name}</Text>; }`,
    "AI-NULL-001",
    "useState<T | null> deref in JSX is flagged",
  );
  await expectClean(
    `function C() {
  const [user] = useState<User | null>(null);
  if (!user) return null;
  return <Text>{user.name}</Text>; }`,
    "Guarded useState JSX is clean",
  );

  console.log("— Deep Logic Analysis");
  await expectFinding(
    `function Price() { const [amount] = useState<number | null>(10); return amount - 2; }`,
    "LOGIC-004",
    "Nullable React state used in arithmetic is flagged",
  );
  await expectFinding(
    `function total(amount: number | null, fee: number) { return amount - fee; }`,
    "LOGIC-004",
    "Nullable utility parameter used in arithmetic is flagged",
  );
  await expectNoFinding(
    `function total(amount: number | null, fee: number) { if (amount == null) return 0; return amount - fee; }`,
    "LOGIC-004",
    "Guarded nullable arithmetic is clean",
  );
  await expectFinding(
    `const divisor = 0; export const ratio = 12 / divisor;`,
    "LOGIC-005",
    "Division by a constant zero is flagged",
  );
  await expectNoFinding(
    `export function ratio(total: number, count: number) { if (count === 0) return 0; return total / count; }`,
    "LOGIC-005",
    "Guarded dynamic division is clean",
  );
  await expectFinding(
    `export const cents = (raw: string) => parseInt(raw, 10) * 100;`,
    "LOGIC-006",
    "Unchecked parsed number used in arithmetic is flagged",
  );
  await expectNoFinding(
    `export const cents = (raw: string) => (Number.parseInt(raw, 10) || 0) * 100;`,
    "LOGIC-006",
    "Parsed number with explicit fallback is clean",
  );
  await expectFinding(
    `export const valid = (value: number) => value !== NaN;`,
    "LOGIC-007",
    "Equality comparison with NaN is flagged",
  );
  await expectNoFinding(
    `export const valid = (value: number) => !Number.isNaN(value);`,
    "LOGIC-007",
    "Number.isNaN validation is clean",
  );
  await expectFinding(
    `function Price() { const [amount, setAmount] = useState<number | null>(10); useEffect(() => setAmount(null), []); return amount.toFixed(2); }`,
    "REACT-021",
    "Nullable state that can change after the initial render is guarded",
  );
  await expectNoFinding(
    `function Price() { const [amount] = useState<number | null>(10); if (amount == null) return null; return amount.toFixed(2); }`,
    "REACT-021",
    "Render-time guard protects nullable state",
  );
  await expectNoFinding(
    `function Form() { const [errors] = useState<Record<string, string | undefined>>({}); return errors.name; }`,
    "REACT-021",
    "Undefined nested record values do not make the state object nullable",
  );
  await expectFinding(
    `export const name = (users: User[]) => users.find(u => u.active).name;`,
    "LOGIC-008",
    "Immediate dereference of Array.find result is flagged",
  );
  await expectNoFinding(
    `export const name = (users: User[]) => users.find(u => u.active)?.name ?? "Unknown";`,
    "LOGIC-008",
    "Optional Array.find result access is clean",
  );
  await expectFinding(
    `export const nextId = (queue: Job[]) => queue.shift().id;`,
    "LOGIC-009",
    "Immediate dereference of Array.shift result is flagged",
  );
  await expectNoFinding(
    `export const nextId = (queue: Job[]) => queue.shift()?.id;`,
    "LOGIC-009",
    "Optional Array.shift result access is clean",
  );
  await expectFinding(
    `export const total = (values: number[]) => values.reduce((a, b) => a + b);`,
    "LOGIC-010",
    "reduce without an initial value is flagged",
  );
  await expectNoFinding(
    `export const total = (values: number[]) => values.reduce((a, b) => a + b, 0);`,
    "LOGIC-010",
    "reduce with an initial value is clean",
  );
  await expectFinding(
    `function status(code: number) { switch (code) { case 1: save(); case 2: send(); break; } }`,
    "LOGIC-011",
    "Unmarked switch fallthrough is flagged",
  );
  await expectNoFinding(
    `function status(code: number) { switch (code) { case 1: save(); break; case 2: send(); break; } }`,
    "LOGIC-011",
    "Terminated switch cases are clean",
  );
  await expectFinding(
    `function Search({ query }) { const [data, setData] = useState(null); useEffect(() => { fetch('/q=' + query).then(r => r.json()).then(setData); }, [query]); return null; }`,
    "REACT-022",
    "Dependency-driven fetch without cancellation is flagged",
  );
  await expectNoFinding(
    `function Search({ query }) { const [data, setData] = useState(null); useEffect(() => { const c = new AbortController(); fetch('/q=' + query, { signal: c.signal }).then(r => r.json()).then(setData); return () => c.abort(); }, [query]); return null; }`,
    "REACT-022",
    "Effect request with cancellation cleanup is clean",
  );
  await expectFinding(
    `function Toast() { const [open, setOpen] = useState(true); useEffect(() => { setTimeout(() => setOpen(false), 1000); }, []); return null; }`,
    "REACT-023",
    "Delayed state update without timeout cleanup is flagged",
  );
  await expectNoFinding(
    `function Toast() { const [open, setOpen] = useState(true); useEffect(() => { const id = setTimeout(() => setOpen(false), 1000); return () => clearTimeout(id); }, []); return null; }`,
    "REACT-023",
    "Delayed state update with timeout cleanup is clean",
  );
  await expectFinding(
    `function Counter() { const [count, setCount] = useState(0); const later = async () => { await save(); setCount(count + 1); }; return null; }`,
    "REACT-024",
    "Async update derived from captured state is flagged",
  );
  await expectNoFinding(
    `function Counter() { const [count, setCount] = useState(0); const later = async () => { await save(); setCount(current => current + 1); }; return null; }`,
    "REACT-024",
    "Functional async state update is clean",
  );
  await expectNoFinding(
    `function Status() { const [dirty, setDirty] = useState(false); const flush = async (controller) => { await controller.flush(); setDirty(controller.dirty); }; return null; }`,
    "REACT-024",
    "A same-named member property is not a captured state read",
  );
  await expectFinding(
    `export async function load() { const response = await fetch('/api/items'); return response.json(); }`,
    "SERVICE-001",
    "Fetch body consumed without status check is flagged",
  );
  await expectNoFinding(
    `export async function load() { const response = await fetch('/api/items'); if (!response.ok) throw new Error('failed'); return response.json(); }`,
    "SERVICE-001",
    "Fetch response checked before body consumption is clean",
  );
  await expectFinding(
    `export async function load() { const controller = new AbortController(); setTimeout(() => controller.abort(), 1000); return fetch('/api', { signal: controller.signal }); }`,
    "SERVICE-002",
    "Uncleared request abort timeout is flagged",
  );
  await expectNoFinding(
    `export async function load() { const controller = new AbortController(); const id = setTimeout(() => controller.abort(), 1000); try { return await fetch('/api', { signal: controller.signal }); } finally { clearTimeout(id); } }`,
    "SERVICE-002",
    "Request abort timeout cleared in finally is clean",
  );

  console.log("— Frontend and API Race Conditions");
  await expectFinding(
    `function load() { const controller = new AbortController(); fetch('/api'); return () => controller.abort(); }`,
    "RACE-001",
    "AbortController disconnected from fetch is flagged",
  );
  await expectNoFinding(
    `function load() { const controller = new AbortController(); fetch('/api', { signal: controller.signal }); return () => controller.abort(); }`,
    "RACE-001",
    "AbortController wired to fetch is clean",
  );
  await expectFinding(
    `function Search() { const [items, setItems] = useState([]); async function search(query: string) { const result = await api.search(query); setItems(result); } return null; }`,
    "RACE-002",
    "Parameterized request can overwrite newer state",
  );
  await expectNoFinding(
    `function Search() { const [items, setItems] = useState([]); const requestId = useRef(0); async function search(query: string) { const id = ++requestId.current; const result = await api.search(query); if (id !== requestId.current) return; setItems(result); } return null; }`,
    "RACE-002",
    "Request generation guard is clean",
  );
  await expectFinding(
    `async function increment() { const prior = await AsyncStorage.getItem('count'); await AsyncStorage.setItem('count', JSON.stringify(Number(prior) + 1)); }`,
    "RACE-003",
    "Storage read-modify-write race is flagged",
  );
  await expectNoFinding(
    `async function replace(value: string) { await AsyncStorage.setItem('count', value); }`,
    "RACE-003",
    "Direct storage replacement is clean",
  );
  await expectFinding(
    `function Screen() { const [loading, setLoading] = useState(false); async function refresh() { setLoading(true); try { await api.get('/items'); } finally { setLoading(false); } } return null; }`,
    "RACE-004",
    "Shared loading boolean around overlapping request is flagged",
  );
  await expectNoFinding(
    `function Screen() { const [loading, setLoading] = useState(false); async function refresh() { if (loading) return; setLoading(true); try { await api.get('/items'); } finally { setLoading(false); } } return null; }`,
    "RACE-004",
    "Explicit loading guard is clean",
  );
  await expectFinding(
    `function Screen() { useEffect(() => { AppState.addListener('change', refresh); }, []); return null; }`,
    "RACE-005",
    "Effect subscription without teardown is flagged",
  );
  await expectNoFinding(
    `function Screen() { useEffect(() => { const sub = AppState.addListener('change', refresh); return () => sub.remove(); }, []); return null; }`,
    "RACE-005",
    "Effect subscription teardown is clean",
  );
  await expectFinding(
    `async function load() { return Promise.race([fetch('/api'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))]); }`,
    "RACE-006",
    "Promise.race timeout without cancellation is flagged",
  );
  await expectNoFinding(
    `async function load() { const controller = new AbortController(); return Promise.race([fetch('/api', { signal: controller.signal }), new Promise((_, reject) => setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 1000))]); }`,
    "RACE-006",
    "Promise.race timeout with abort is clean",
  );
  await expectFinding(
    `function Cart() { const [items, setItems] = useState([]); async function remove(id: string) { const previous = items; setItems(items.filter(x => x.id !== id)); try { await api.delete('/items/' + id); } catch { setItems(previous); } } return null; }`,
    "RACE-007",
    "Unconditional optimistic rollback is flagged",
  );
  await expectNoFinding(
    `function Cart() { const [items, setItems] = useState([]); async function remove(id: string) { setItems(items.filter(x => x.id !== id)); try { await api.delete('/items/' + id); } catch { refetch(); } } return null; }`,
    "RACE-007",
    "Refetch reconciliation avoids stale snapshot rollback",
  );
  await expectFinding(
    `function Search() { useState(''); let timer = null; const change = (value: string) => { clearTimeout(timer); timer = setTimeout(() => search(value), 200); }; return null; }`,
    "RACE-008",
    "Render-local debounce timer is flagged",
  );
  await expectNoFinding(
    `function Search() { useState(''); const timer = useRef(null); const change = (value: string) => { clearTimeout(timer.current); timer.current = setTimeout(() => search(value), 200); }; return null; }`,
    "RACE-008",
    "Ref-backed debounce timer is clean",
  );

  console.log("— API and Server-State Correctness");
  await expectFinding(
    `function useReport(accountId: string, date: string) { return useQuery({ queryKey: ['report', accountId], queryFn: () => api.getReport(accountId, date) }); }`,
    "QUERY-001",
    "React Query key missing a request parameter is flagged",
  );
  await expectNoFinding(
    `function useReport(accountId: string, date: string) { return useQuery({ queryKey: ['report', accountId, date], queryFn: () => api.getReport(accountId, date) }); }`,
    "QUERY-001",
    "React Query key with every request parameter is clean",
  );
  await expectNoFinding(
    `
    function usePosCatalog(offlineDetails: { database: string; catalogueGenerationId: string } | undefined) {
      const generationId = offlineDetails?.catalogueGenerationId ?? "";
      return useQuery({
        queryKey: ['pos-catalog', generationId],
        queryFn: () => {
          if (!offlineDetails) {
            throw new Error('catalogue not ready');
          }
          return api.loadCatalog(offlineDetails.database);
        },
      });
    }
  `,
    "QUERY-001",
    "Derived key input with projection-only queryFn use is clean",
  );
  await expectFinding(
    `
    function usePosCart(offlineDetails: { database: string; catalogueGenerationId: string } | undefined) {
      const generationId = offlineDetails?.catalogueGenerationId ?? "";
      return useQuery({
        queryKey: ['pos-cart', generationId],
        queryFn: () => {
          return api.buildCart(offlineDetails);
        },
      });
    }
  `,
    "QUERY-001",
    "Whole-object use of a derived input is still flagged",
  );
  {
    const result = await verifier.verifyCode(
      `import axios from 'axios'; export const api = axios.create({ baseURL: '/api' });`,
      "src/services/apiClient.ts",
    );
    assert(
      result.diagnostics.some((d) => d.ruleId === "SERVICE-003"),
      "Central Axios client without timeout is flagged",
    );
  }
  {
    const result = await verifier.verifyCode(
      `import axios from 'axios'; export const api = axios.create({ baseURL: '/api', timeout: 15000 });`,
      "src/services/apiClient.ts",
    );
    assert(
      !result.diagnostics.some((d) => d.ruleId === "SERVICE-003"),
      "Central Axios client with timeout is clean",
    );
  }
  await expectFinding(
    `async function login() { const response = await api.post('/login'); const user = response.data; if (import.meta.env.DEV) { UserSchema.safeParse(user); } return user; }`,
    "SERVICE-004",
    "Development-only response validation is flagged",
  );
  await expectNoFinding(
    `async function login() { const response = await api.post('/login'); return UserSchema.parse(response.data); }`,
    "SERVICE-004",
    "Production response validation is clean",
  );
  {
    const result = await verifier.verifyCode(
      `export async function upload(file: File) { return axios.put('/upload', file); }`,
      "src/services/uploadService.ts",
    );
    assert(
      result.diagnostics.some((d) => d.ruleId === "SERVICE-005"),
      "Upload without a file-size bound is flagged",
    );
  }
  {
    const result = await verifier.verifyCode(
      `export async function upload(file: File) { if (file.size > 5_000_000) throw new Error('too large'); return axios.put('/upload', file); }`,
      "src/services/uploadService.ts",
    );
    assert(
      !result.diagnostics.some((d) => d.ruleId === "SERVICE-005"),
      "Upload with a file-size bound is clean",
    );
  }
  {
    const result = await verifier.verifyCode(
      `api.interceptors.response.use(ok => ok, async error => { if (error.response.status === 401) { const token = await refreshToken(); return api(error.config); } throw error; });`,
      "src/services/apiClient.ts",
    );
    assert(
      result.diagnostics.some((d) => d.ruleId === "RACE-009"),
      "Uncoordinated auth refresh is flagged",
    );
  }
  {
    const result = await verifier.verifyCode(
      `let refreshPromise: Promise<string> | null = null; api.interceptors.response.use(ok => ok, async error => { if (error.response.status === 401) { refreshPromise ??= refreshToken(); try { await refreshPromise; return api(error.config); } finally { refreshPromise = null; } } throw error; });`,
      "src/services/apiClient.ts",
    );
    assert(
      !result.diagnostics.some((d) => d.ruleId === "RACE-009"),
      "Single-flight auth refresh is clean",
    );
  }
  await expectFinding(
    `function useCreateOrder() { return useMutation({ mutationFn: (order) => api.post('/orders', order), retry: 3 }); }`,
    "MUTATION-001",
    "Retried write without idempotency is flagged",
  );
  await expectNoFinding(
    `function useCreateOrder() { return useMutation({ mutationFn: (order) => api.post('/orders', order, { headers: { 'Idempotency-Key': order.operationId } }), retry: 3 }); }`,
    "MUTATION-001",
    "Retried write with operation identity is clean",
  );
  await expectFinding(
    `function useFeed() { return useInfiniteQuery({ queryKey: ['feed'], queryFn: () => api.getFeed(), getNextPageParam: last => last.nextCursor }); }`,
    "QUERY-002",
    "Infinite query that ignores pageParam is flagged",
  );
  await expectFinding(
    `function useFeed() { return useInfiniteQuery({ queryKey: ['feed'], queryFn: ({ pageParam }) => api.getFeed(pageParam) }); }`,
    "QUERY-002",
    "Infinite query without cursor progression is flagged",
  );
  await expectNoFinding(
    `function useFeed() { return useInfiniteQuery({ queryKey: ['feed'], queryFn: ({ pageParam }) => api.getFeed(pageParam), getNextPageParam: last => last.nextCursor }); }`,
    "QUERY-002",
    "Cursor-driven infinite query is clean",
  );
  {
    const result = await verifier.verifyCode(
      `export function enqueueOffline(payload) { queue.push({ method: 'post', payload }); }`,
      "src/offline/mutationQueue.ts",
    );
    assert(
      result.diagnostics.some((d) => d.ruleId === "OFFLINE-001"),
      "Offline write without replay identity is flagged",
    );
  }
  {
    const result = await verifier.verifyCode(
      `export function enqueueOffline(payload) { queue.push({ operationId: crypto.randomUUID(), method: 'post', payload }); }`,
      "src/offline/mutationQueue.ts",
    );
    assert(
      !result.diagnostics.some((d) => d.ruleId === "OFFLINE-001"),
      "Offline write with replay identity is clean",
    );
  }
  {
    const result = await verifier.verifyCode(
      `export function collect(payloads) { const protectedIds = new Set<string>(); for (const payload of payloads) protectedIds.add(payload.requestId); return protectedIds; }`,
      "src/offline/catalogueProtection.ts",
    );
    assert(
      !result.diagnostics.some((d) => d.ruleId === "OFFLINE-001"),
      "Set membership collection is not treated as an offline write queue",
    );
  }
  await expectFinding(
    `function usePrices(socket) { const [prices, setPrices] = useState({}); socket.onmessage = event => { setPrices(JSON.parse(event.data)); }; return prices; }`,
    "RACE-010",
    "Unordered realtime replacement is flagged",
  );
  await expectNoFinding(
    `function usePrices(socket) { const [prices, setPrices] = useState({}); let lastSequence = 0; socket.onmessage = event => { const message = JSON.parse(event.data); if (message.sequence <= lastSequence) return; lastSequence = message.sequence; setPrices(message.data); }; return prices; }`,
    "RACE-010",
    "Sequence-guarded realtime replacement is clean",
  );
  await expectFinding(
    `function Form() { const mutation = useMutation({ mutationFn: save }); const handleSubmit = async () => { await mutation.mutateAsync(); }; return <form onSubmit={handleSubmit} />; }`,
    "MUTATION-002",
    "Submit mutation without a pending guard is flagged",
  );
  await expectNoFinding(
    `function Form() { const mutation = useMutation({ mutationFn: save }); const handleSubmit = async () => { if (mutation.isPending) return; await mutation.mutateAsync(); }; return <form onSubmit={handleSubmit}><button disabled={mutation.isPending} /></form>; }`,
    "MUTATION-002",
    "Pending-guarded submit mutation is clean",
  );
  await expectFinding(
    `function useSaveItem() { return useMutation({ mutationFn: save, onSuccess(data, variables) { queryClient.setQueryData(['item-detail'], { ...data, id: variables.id }); } }); }`,
    "QUERY-003",
    "Detail cache write without entity identity is flagged",
  );
  await expectNoFinding(
    `function useSaveItem() { return useMutation({ mutationFn: save, onSuccess(data, variables) { queryClient.setQueryData(['item-detail', variables.id], data); } }); }`,
    "QUERY-003",
    "Entity-scoped detail cache write is clean",
  );
  await expectFinding(
    `function useSave() { return useMutation({ mutationFn: save, onSuccess() { queryClient.invalidateQueries({ queryKey: ['items'] }); navigate('/items'); } }); }`,
    "QUERY-004",
    "Background mutation invalidation is flagged",
  );
  await expectNoFinding(
    `function useSave() { return useMutation({ mutationFn: save, async onSuccess() { await queryClient.invalidateQueries({ queryKey: ['items'] }); } }); }`,
    "QUERY-004",
    "Awaited mutation invalidation is clean",
  );
  await expectNoFinding(
    `function useSave() { return useMutation({ mutationFn: save, onSuccess() { void queryClient.invalidateQueries({ queryKey: ['items'] }); onClose(); } }); }`,
    "QUERY-004",
    "Explicitly voided fire-and-forget mutation invalidation is clean",
  );
  await expectNoFinding(
    `function extract(text: string) {
      const re = /@(\\w+)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const token = match[1];
        if (token) console.log(token);
      }
    }`,
    "AI-NULL-001",
    "Assignment inside while !== null condition narrows assigned variable to non-null",
  );
  await expectNoFinding(
    `function initials(name?: string | null): string {
      if (!name?.trim()) return '?';
      return name.trim().toUpperCase();
    }`,
    "AI-NULL-001",
    "Optional call guard (!name?.trim()) narrows base identifier on fallthrough",
  );
  await expectFinding(
    `async function load() { setLoading(true); const result = await api.get('/items'); setItems(result.data); setLoading(false); }`,
    "STATE-001",
    "Loading state cleared only after successful await is flagged",
  );
  await expectNoFinding(
    `async function load() { setLoading(true); try { const result = await api.get('/items'); setItems(result.data); } finally { setLoading(false); } }`,
    "STATE-001",
    "Loading state cleared in finally is clean",
  );
  {
    const result = await verifier.verifyCode(
      `import { UserSchema } from './schemas'; export async function getUser() { const response = await api.get('/user'); return response.data; }`,
      "src/services/userApi.ts",
    );
    assert(
      result.diagnostics.some((d) => d.ruleId === "SERVICE-006"),
      "Available response schema bypass is flagged",
    );
  }
  {
    const result = await verifier.verifyCode(
      `import { UserSchema } from './schemas'; export async function getUser() { const response = await api.get('/user'); return UserSchema.parse(response.data); }`,
      "src/services/userApi.ts",
    );
    assert(
      !result.diagnostics.some((d) => d.ruleId === "SERVICE-006"),
      "Response parsed with available schema is clean",
    );
  }
  {
    const result = await verifier.verifyCode(
      `import { PhotoPresignSchema } from './schemas'; export async function uploadPhoto(file: File) { const presign = await apiRequest('/photo/presign', { schema: PhotoPresignSchema }); const response = await fetch(presign.data.upload_url, { method: 'PUT', body: file }); if (!response.ok) throw new Error('upload failed'); return presign.data.public_url; }`,
      "src/services/photoApi.ts",
    );
    assert(
      !result.diagnostics.some((d) => d.ruleId === "SERVICE-006"),
      "Binary upload does not make validated presign data look like a raw response",
    );
  }
  {
    const result = await verifier.verifyCode(
      `import { UserSchema } from './schemas'; export async function getUserName() { const response = await api.get('/user'); return response.data.name; }`,
      "src/services/userApi.ts",
    );
    assert(
      result.diagnostics.some((d) => d.ruleId === "SERVICE-006"),
      "Nested raw response data is still flagged",
    );
  }
  {
    const fixtureRoot = path.resolve(__dirname, "fixtures/project-summaries");
    const helper = path.join(fixtureRoot, "coordinated-refresh.fixture");
    const consumer = path.join(fixtureRoot, "refresh-consumer.fixture");
    const projectVerifier = new CodeVerifier({
      projectSummaryIndex: ProjectSummaryIndex.fromFiles([helper, consumer]),
    });
    const result = await projectVerifier.verifyFile(consumer);
    assert(
      !result.diagnostics.some((d) => d.ruleId === "RACE-009"),
      "Imported single-flight refresh helper is recognized across files",
    );
  }

  console.log("— Form Contracts and Style Consistency");
  {
    const fixtureRoot = path.resolve(__dirname, "fixtures/ui-project");
    const files = expandAllFiles(fixtureRoot);
    const projectVerifier = new CodeVerifier({
      projectUiIndex: ProjectUiIndex.fromFiles(files),
      projectRoot: fixtureRoot,
    });
    const drawer = await projectVerifier.verifyFile(
      path.join(fixtureRoot, "BranchDrawer.tsx"),
    );
    assert(
      drawer.diagnostics.some((d) => d.ruleId === "FORM-001"),
      "Schema-derived form submitted without safeParse is flagged",
    );
    assert(
      drawer.diagnostics.some(
        (d) =>
          d.ruleId === "FORM-002" &&
          /address/.test(d.message) &&
          /area/.test(d.message),
      ),
      "Partial manual validation names omitted required fields",
    );
    assert(
      drawer.diagnostics.some((d) => d.ruleId === "FORM-003"),
      "Silent form validation return is flagged",
    );
    assert(
      drawer.diagnostics.some((d) => d.ruleId === "FORM-004"),
      "Missing field-error propagation is flagged",
    );
    assert(
      drawer.diagnostics.some((d) => d.ruleId === "FORM-005"),
      "Closing immediately after submission is flagged",
    );
    const validDrawer = await projectVerifier.verifyFile(
      path.join(fixtureRoot, "BranchDrawerValid.tsx"),
    );
    assert(
      !validDrawer.diagnostics.some((d) => /^FORM-00[1-5]$/.test(d.ruleId)),
      "Schema validation, error propagation, and awaited submit remain clean",
    );

    const styled = await projectVerifier.verifyFile(
      path.join(fixtureRoot, "StyledCard.tsx"),
    );
    assert(
      styled.diagnostics.some(
        (d) => d.ruleId === "STYLE-001" && /missing/.test(d.message),
      ),
      "Undefined TypeScript style key is flagged",
    );
    const styleDefinition = await projectVerifier.verifyFile(
      path.join(fixtureRoot, "cardStyles.ts"),
    );
    assert(
      styleDefinition.diagnostics.some(
        (d) => d.ruleId === "STYLE-002" && /obsolete/.test(d.message),
      ),
      "Unused TypeScript style key is flagged",
    );

    const css = await projectVerifier.verifyFile(
      path.join(fixtureRoot, "CssCard.tsx"),
    );
    assert(
      css.diagnostics.some(
        (d) => d.ruleId === "STYLE-001" && /missing/.test(d.message),
      ),
      "Undefined CSS-module class is flagged",
    );
    assert(
      css.diagnostics.some(
        (d) => d.ruleId === "STYLE-001" && /ghost-query/.test(d.message),
      ),
      "Undefined programmatic querySelector class is flagged",
    );
    assert(
      !css.diagnostics.some(
        (d) => d.ruleId === "STYLE-001" && /legacy-hook/.test(d.message),
      ),
      "Undefined plain class on an explicitly styled element stays quiet",
    );
    assert(
      css.diagnostics.some(
        (d) => d.ruleId === "STYLE-002" && /obsolete/.test(d.message),
      ),
      "Unused CSS-module class is flagged",
    );
    assert(
      !css.diagnostics.some(
        (d) => d.ruleId === "STYLE-002" && /label/.test(d.message),
      ),
      "Programmatic querySelector reference counts as CSS usage",
    );
    {
      const viteRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "code-verifier-vite-css-"),
      );
      fs.writeFileSync(
        path.join(viteRoot, "tsconfig.json"),
        JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
      );
      fs.writeFileSync(
        path.join(viteRoot, "tsconfig.app.json"),
        JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./src/*"] } },
        }),
      );
      fs.mkdirSync(path.join(viteRoot, "src/styles"), { recursive: true });
      fs.writeFileSync(
        path.join(viteRoot, "src/styles/base.css"),
        `.theme-card { padding: 8px; }`,
      );
      fs.writeFileSync(
        path.join(viteRoot, "src/styles/index.css"),
        `@import './base.css';`,
      );
      const compFile = path.join(viteRoot, "src/App.tsx");
      fs.writeFileSync(
        compFile,
        `import '@/styles/index.css';
        export function App() {
          const root = document.documentElement;
          root.classList.add('light');
          root.classList.remove('light');
          return <div className="theme-card" />;
        }`,
      );
      const viteUiIndex = ProjectUiIndex.fromFiles([compFile]);
      const viteVerifier = new CodeVerifier({
        projectRoot: viteRoot,
        projectUiIndex: viteUiIndex,
      });
      const viteResult = await viteVerifier.verifyFile(compFile);
      assert(
        !viteResult.diagnostics.some((d) => d.ruleId === "STYLE-001"),
        "Referenced tsconfig paths, CSS @import, and root classList theme toggles do not trigger STYLE-001",
      );
    }

    const badConsumer = await projectVerifier.verifyFile(
      path.join(fixtureRoot, "BadComponentConsumer.tsx"),
    );
    assert(
      badConsumer.diagnostics.some(
        (d) => d.ruleId === "COMP-001" && /title/.test(d.message),
      ),
      "Required prop missing through a barrel export is flagged",
    );
    assert(
      badConsumer.diagnostics.some(
        (d) => d.ruleId === "COMP-002" && d.abstractInvariants?.["1.contract"],
      ),
      "Async callback passed to a synchronous prop has an explainable proof trace",
    );
    assert(
      badConsumer.diagnostics.some(
        (d) => d.ruleId === "COMP-003" && /user/.test(d.message),
      ),
      "Explicit null passed to a non-nullable prop is flagged",
    );
    const safeConsumer = await projectVerifier.verifyFile(
      path.join(fixtureRoot, "SafeComponentConsumer.tsx"),
    );
    assert(
      !safeConsumer.diagnostics.some((d) => /^COMP-/.test(d.ruleId)),
      "Satisfied TypeScript component contracts remain clean",
    );
    const legacyConsumer = await projectVerifier.verifyFile(
      path.join(fixtureRoot, "LegacyConsumer.jsx"),
    );
    assert(
      legacyConsumer.diagnostics.some(
        (d) => d.ruleId === "COMP-001" && /label/.test(d.message),
      ),
      "Required JavaScript PropTypes prop is flagged",
    );
  }
  await expectFinding(
    `function Field() { const [name, setName] = useState<string>(); return <input value={name} onChange={(event) => setName(event.target.value)} />; }`,
    "COMP-004",
    "Controlled input state initialized as undefined is flagged",
  );
  await expectNoFinding(
    `function Field() { const [name, setName] = useState(''); return <input value={name} onChange={(event) => setName(event.target.value)} />; }`,
    "COMP-004",
    "Controlled input with a defined initial value remains clean",
  );
  await expectNoFinding(
    `function Upload() { const [files] = useState([]); const handleSubmit = () => { if (files.length === 0) return; upload(files); }; return <button disabled={files.length === 0} onClick={handleSubmit}>Upload</button>; }`,
    "FORM-003",
    "Disabled submit control explains an empty-input guard",
  );
  await expectNoFinding(
    `function useSubmit() { const handleSubmit = () => mutate(undefined, { onError(error) { if (isTerminal(error.message)) return; setError(error.message); } }); return handleSubmit; }`,
    "FORM-003",
    "Nested terminal-error callback is not mistaken for silent form validation",
  );
  await expectNoFinding(
    `interface Props { onSave: (value: string) => void; onClose: () => void; } function Form({ onSave, onClose }: Props) { const handleSave = () => { onSave('ok'); onClose(); }; return <button onClick={handleSave}>Save</button>; }`,
    "FORM-005",
    "Explicitly synchronous submit callback can safely close immediately",
  );

  console.log("— Hygiene Rules");
  await expectFinding(
    `<a href="https://x.com" target="_blank">go</a>`,
    "WEB-001",
    "target=_blank without rel is flagged",
  );
  await expectClean(
    `<a href="https://x.com" target="_blank" rel="noopener noreferrer">go</a>`,
    "target=_blank with rel=noopener is clean",
  );
  await expectFinding(
    `function f() { debugger; }`,
    "HYG-001",
    "debugger statement is flagged",
  );
  await expectFinding(
    `const apiUrl = 'http://api.example-real.dev/v1';`,
    "NET-001",
    "http:// in url-ish var is flagged",
  );
  await expectClean(
    `const note = 'http://example.com/see-also';`,
    "example.com http is exempt",
  );
  await expectClean(
    `const cfg = { baseURL: 'http://localhost:3000' };`,
    "localhost http is exempt",
  );

  console.log("— Hygiene: Unused Imports (HYG-003)");
  await expectFinding(
    `import { unused1 } from "./x"; export const a = 1;`,
    "HYG-003",
    "Detects unused named import",
  );
  await expectFinding(
    `import Header from "./Header"; export const a = 1;`,
    "HYG-003",
    "Detects unused default import",
  );
  await expectFinding(
    `import * as fs2 from "fs-extra"; export const a = 1;`,
    "HYG-003",
    "Detects unused namespace import",
  );
  await expectNoFinding(
    `import type { Foo } from "./types"; export const a = 1;`,
    "HYG-003",
    "Type-only imports are exempt",
  );
  await expectNoFinding(
    `import { Foo } from "./types"; type Wrapper = { f: Foo }; export type { Wrapper };`,
    "HYG-003",
    "Import used only in a type annotation stays quiet",
  );
  await expectNoFinding(
    `import React from "react"; export function Screen() { return <div />; }`,
    "HYG-003",
    "React default import with JSX is exempt",
  );
  await expectNoFinding(
    `import { View } from "react-native"; export function Screen() { return <View />; }`,
    "HYG-003",
    "Import used in JSX is used",
  );
  await expectNoFinding(
    `import "./polyfill"; export const a = 1;`,
    "HYG-003",
    "Side-effect import stays quiet",
  );
  await expectNoFinding(
    `import { inner } from "./inner"; export { inner };`,
    "HYG-003",
    "Re-exported symbol is exempt",
  );
  await expectNoFinding(
    `import { _draft } from "./x"; export const a = 1;`,
    "HYG-003",
    "Underscore-prefixed import is exempt",
  );
  await expectNoFinding(
    `import { value } from "./x"; export const a = value;`,
    "HYG-003",
    "Used import stays quiet",
  );

  console.log("— Hygiene: Orphaned Files (HYG-004)");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-orphan-"));
    const write = (rel: string, content: string): void => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    };
    write("index.ts", `import { greet } from "./lib/used";\ngreet();\n`);
    write("lib/used.ts", `export const greet = () => "hi";\n`);
    write("lib/orphan.ts", `export const dead = 1;\n`);
    write("App.tsx", `export default function App() { return null; }\n`);
    write(
      "app/profile.tsx",
      `export default function Profile() { return null; }\n`,
    );
    write(
      "src/api.test.ts",
      `import { used } from "./api";\nexpect(used).toBe(1);\n`,
    );
    write("src/api.ts", `export const used = 1;\n`);
    write("src/Widget.tsx", `export const Widget = () => null;\n`);
    write("src/Widget.android.tsx", `export const Widget = () => null;\n`);
    write("src/screen.ts", `import { Widget } from "./Widget";\nWidget();\n`);
    write("server/mcp.ts", `export const serve = () => "mcp";\n`);
    write("scripts/unreferenced.ts", `export const stale = true;\n`);
    write(
      "src/utils/index.ts",
      `export * from "./used";\nexport * from "./dead";\n`,
    );
    write("src/utils/used.ts", `export const live = 1;\n`);
    write("src/utils/dead.ts", `export const dead = 1;\n`);
    write(
      "src/useUtils.ts",
      `import { live } from "./utils";\nconsole.log(live);\n`,
    );
    write(
      "package.json",
      JSON.stringify({ scripts: { mcp: "tsx server/mcp.ts" } }),
    );
    const index = ImportGraphIndex.fromFiles(expandAllFiles(dir), dir);
    const reachable = (rel: string): boolean =>
      index.isReachable(path.join(dir, rel));
    assert(
      reachable("lib/used.ts"),
      "Imported file is reachable",
      "lib/used.ts",
    );
    assert(
      !reachable("lib/orphan.ts"),
      "Orphaned file is not reachable",
      "lib/orphan.ts",
    );
    assert(
      reachable("src/Widget.android.tsx"),
      "React Native platform variant is reachable through its extensionless import",
      "src/Widget.android.tsx",
    );
    assert(reachable("App.tsx"), "Entry point App.tsx is exempt");
    assert(reachable("app/profile.tsx"), "Expo Router route is exempt");
    assert(reachable("src/api.test.ts"), "Test file is exempt");
    assert(
      reachable("server/mcp.ts"),
      "package.json script target is an entry point",
    );
    assert(
      !reachable("scripts/unreferenced.ts"),
      "Unreferenced script-directory file is still orphaned",
    );
    assert(
      reachable("src/api.ts"),
      "File imported only by a test file is reachable",
      "test import edge counts",
    );
    assert(
      reachable("src/utils/used.ts"),
      "Barrel re-exported file is reachable when its exported symbol is imported",
      "used barrel export",
    );
    assert(
      !reachable("src/utils/dead.ts"),
      "Barrel-only file is orphaned when none of its exported symbols are imported",
      "unused barrel export",
    );
    write(
      "src/views/Bloom.tsx",
      `export default function Bloom() { return null; }\n`,
    );
    write(
      "src/views/Bloom.android.tsx",
      `export default function Bloom() { return null; }\n`,
    );
    write("src/tooling/_fabric-native-components.jsx", `export default {};`);
    // Root tsconfig.json as a project-references shell, paths in the
    // referenced app config (Vite-style) — the shell itself has no paths.
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.app.json" }],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "tsconfig.app.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
        include: ["src"],
      }),
    );
    write(
      "src/screens/Home.tsx",
      `import { Bloom } from "@/views/Bloom";\nexport const H = Bloom;\n`,
    );
    const indexWithAliases = ImportGraphIndex.fromFiles(
      expandAllFiles(dir),
      dir,
    );
    const reachableWithAliases = (rel: string): boolean =>
      indexWithAliases.isReachable(path.join(dir, rel));
    assert(
      reachableWithAliases("src/views/Bloom.tsx"),
      "tsconfig alias import edge is resolved (via project references)",
      "alias resolution through references shell",
    );
    assert(
      reachableWithAliases("src/views/Bloom.android.tsx"),
      "Platform-suffixed sibling is exempt",
      "platform file",
    );
    assert(
      reachableWithAliases("src/tooling/_fabric-native-components.jsx"),
      "Underscore-prefixed tooling entry is exempt",
      "underscore entry",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("— Hygiene: Chained Star Re-Exports and Service-Worker Entries");
  {
    // vbook regressions.
    // 1. A barrel chain of two `export *` hops (index -> service -> sibling
    //    service re-exported via an alias-qualified star re-export): the
    //    barrel's exposed-name set must be the target's transitive public
    //    surface, or a genuinely consumed sibling looked orphaned.
    // 2. `src/sw.ts` generated for vite-plugin-pwa's injectManifest is a
    //    service-worker entry registered through browser APIs, not imported.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-orphan-chain-"));
    const write = (rel: string, content: string): void => {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    write(
      "src/features/auth/services/index.ts",
      `export * from "./authService";\n`,
    );
    write(
      "src/features/auth/services/authService.ts",
      `export const signIn = (): number => 1;\nexport * from "@/features/auth/services/authAccountRecoveryService";\n`,
    );
    write(
      "src/features/auth/services/authAccountRecoveryService.ts",
      `export const recoverAccount = (): number => 2;\nexport const requestRecovery = (): number => 3;\n`,
    );
    write(
      "src/features/auth/useAuthMutations.tsx",
      `import { recoverAccount } from "@/features/auth/services";\nexport const run = (): number => recoverAccount();\n`,
    );
    write("src/sw.ts", `self.addEventListener("install", () => {});\n`);
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
        include: ["src"],
      }),
    );
    const chainIndex = ImportGraphIndex.fromFiles(expandAllFiles(dir), dir);
    const reachable = (rel: string): boolean =>
      chainIndex.isReachable(path.join(dir, rel));
    assert(
      reachable("src/features/auth/services/authAccountRecoveryService.ts"),
      "Chained star re-export surface is transitive: consumed sibling stays reachable",
      "chained export *",
    );
    assert(
      reachable("src/sw.ts"),
      "Service-worker entry file (sw.ts) is exempt",
      "sw entry",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("— Hygiene: Value+Type Re-Export of the Same Target (folder barrel)");
  {
    // vbook regression (PosCart et al.). A folder barrel re-exporting the same
    // target twice — `export { X } from './X.tsx'` followed by
    // `export type { XProps } from './X.tsx'` — must MERGE the exposed-name
    // sets. The old recordReExport overwrote the value names with the type
    // names, so the consumer's `import { X }` no longer matched and the
    // re-exported file looked orphaned.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-orphan-vtype-"));
    const write = (rel: string, content: string): void => {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    write(
      "src/features/sales/components/pos/PosCart/PosCart.tsx",
      `export interface PosCartProps { items: string[] }\nexport const PosCart = (props: PosCartProps): string => props.items[0];\n`,
    );
    write(
      "src/features/sales/components/pos/PosCart/index.ts",
      `export { PosCart } from './PosCart.tsx';\nexport type { PosCartProps } from './PosCart.tsx';\n`,
    );
    write(
      "src/features/sales/components/pos/PosCartPanel/PosCartPanel.tsx",
      `import { PosCart } from '../PosCart';\nexport const Panel = (): string => PosCart({ items: [] });\n`,
    );
    const index = ImportGraphIndex.fromFiles(expandAllFiles(dir), dir);
    assert(
      index.isReachable(
        path.join(dir, "src/features/sales/components/pos/PosCart/PosCart.tsx"),
      ),
      "Folder barrel value+type re-export: consumer-imported value name stays reachable",
      "value+type re-export merge",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("— Crash-Proofing");
  {
    const res = await verifier.verifyCode(`const broken = {`, "crash.ts");
    const parse = res.diagnostics.find((d) => d.ruleId === "PARSE-001");
    assert(
      !!parse && res.status === "INCOMPLETE" && !res.passed,
      "Parse failure makes verification incomplete",
    );
    const sarif = JSON.parse(formatSARIF([res]));
    assert(
      sarif.runs[0].invocations[0].executionSuccessful === false &&
        sarif.runs[0].invocations[0].toolExecutionNotifications.length > 0,
      "SARIF reports incomplete execution with notifications",
    );
  }
  {
    const verifier2 = new CodeVerifier({
      disabledRules: ["AI-NULL-001"],
      severityOverrides: { "NET-001": "INFO" },
    });
    const res = await verifier2.verifyCode(
      `function f(u: { a: number } | null) { return u.a; }`,
      "cfg.ts",
    );
    assert(
      !res.diagnostics.some((d) => d.ruleId === "AI-NULL-001"),
      "disabledRules suppresses rule",
    );
    const res2 = await verifier2.verifyCode(
      `const apiUrl = 'http://private.example.dev/api';`,
      "cfg2.ts",
    );
    const net = res2.diagnostics.find((d) => d.ruleId === "NET-001");
    assert(
      net !== undefined && net.severity === "INFO",
      "severityOverrides remaps severity",
    );
  }

  console.log("— Fixed-Point Coverage");
  // Regression: an entry node with zero leading statements (body starts with
  // `if`/`switch`/`while`) used to produce an unchanged stateOut on its first
  // visit, never enqueueing successors — the whole downstream body was
  // silently un-analyzed. These bodies MUST still be analyzed.
  await expectFinding(
    `function f(u: { a: number } | null) { if (Math.random()) return 0; return u.a; }`,
    "AI-NULL-001",
    "if-first body still analyzes (first-visit enqueue)",
  );
  await expectClean(
    `function f(u: { a: number } | null) { if (!u) return 0; return u.a; }`,
    "if-first body still refines guards",
  );
  await expectFinding(
    `function f(u: { a: number } | null) { while (Math.random()) { const b = u.a; } return 0; }`,
    "AI-NULL-001",
    "while-first body still analyzes",
  );
  await expectFinding(
    `const f = () => { if (Math.random()) return null; const u: { a: string } | null = null; return u.a; };`,
    "AI-NULL-001",
    "nested control-flow-first arrow still analyzes",
  );

  console.log("— Rule Registry and Status Contract");
  {
    const errors = validateRuleRegistry(ALL_RULES);
    assert(
      errors.length === 0,
      "Every implemented rule has unique registry metadata",
      errors.join("; "),
    );
    assert(
      RULE_REGISTRY.size === ALL_RULES.length,
      "Registry and implementation counts match",
    );
    const res = await verifier.verifyCode(
      `function f() { debugger; }`,
      "metadata.ts",
    );
    assert(
      res.status === "PASSED" && res.passed,
      "Advisory-only completed scan passes",
    );
    assert(
      res.diagnostics[0]?.confidence === "HIGH",
      "Registry confidence propagates to diagnostics",
    );
    assert(
      res.checks.every((check) => check.status === "PASSED"),
      "Completed scan reports all required checks passed",
    );
    assert(classifyESLintExit(0) === "PASSED", "ESLint exit 0 maps to passed");
    assert(
      classifyESLintExit(1) === "FAILED",
      "ESLint exit 1 maps to findings",
    );
    assert(
      classifyESLintExit(2) === "INCOMPLETE",
      "ESLint exit 2 maps to tool failure",
    );
    assert(
      summarizeESLintOutput(
        JSON.stringify([
          {
            filePath: "/repo/a.ts",
            errorCount: 1,
            warningCount: 2,
            messages: [
              { ruleId: "no-undef", message: "x is not defined", line: 3 },
            ],
          },
        ]),
      ).startsWith("1 error(s), 2 warning(s) in 1 file(s)"),
      "ESLint JSON is summarized without dumping the payload",
    );
    assert(
      summarizeNpmAuditOutput(
        JSON.stringify({
          metadata: {
            vulnerabilities: {
              total: 2,
              critical: 1,
              high: 1,
              moderate: 0,
              low: 0,
            },
          },
        }),
      ) === "2 vulnerabilities (critical: 1, high: 1, moderate: 0, low: 0)",
      "npm audit JSON is summarized by severity",
    );
    assert(
      classifyNpmAuditExit(
        1,
        JSON.stringify({
          metadata: { vulnerabilities: { total: 1, high: 1 } },
        }),
      ) === "FAILED",
      "npm audit findings map to failed",
    );
    assert(
      classifyNpmAuditExit(
        1,
        `npm error\n${JSON.stringify({ error: { summary: "registry unavailable" } })}`,
      ) === "INCOMPLETE",
      "npm audit network/tool errors map to incomplete",
    );
  }

  console.log("— Cross-File Function Summaries");
  {
    const fixtureRoot = path.resolve(__dirname, "fixtures/project-summaries");
    const helper = path.join(fixtureRoot, "helpers.fixture");
    const barrel = path.join(fixtureRoot, "barrel.fixture");
    const barrelChain = path.join(fixtureRoot, "barrel-chain.fixture");
    const consumer = path.join(fixtureRoot, "consumer.fixture");
    const aliasConsumer = path.join(fixtureRoot, "alias-consumer.fixture");
    const layer = path.join(fixtureRoot, "layer.fixture");
    const deepConsumer = path.join(fixtureRoot, "deep-consumer.fixture");
    const projectFiles = [
      helper,
      barrel,
      barrelChain,
      consumer,
      aliasConsumer,
      layer,
      deepConsumer,
    ];
    const projectVerifier = new CodeVerifier({
      projectSummaryIndex: ProjectSummaryIndex.fromFiles(projectFiles),
    });
    const res = await projectVerifier.verifyFile(consumer);
    assert(
      res.diagnostics.some((d) => d.ruleId === "AI-TAINT-001"),
      "Taint crosses relative imported passthrough helpers",
    );
    assert(
      res.diagnostics.some((d) => d.ruleId === "AI-NULL-001"),
      "Nullability crosses relative imported helpers",
    );
    const aliasRes = await projectVerifier.verifyFile(aliasConsumer);
    assert(
      aliasRes.diagnostics.some(
        (d) =>
          d.ruleId === "AI-TAINT-001" && d.message.includes("helper function"),
      ),
      "Taint and sink effects cross TypeScript paths aliases",
    );
    const deepRes = await projectVerifier.verifyFile(deepConsumer);
    assert(
      deepRes.diagnostics.some((d) => d.ruleId === "AI-TAINT-001"),
      "Taint and sink effects compose through multiple imported helper layers",
    );

    const fieldFlow = await new CodeVerifier().verifyCode(
      `
      function select(input) { return input.payload; }
      function unwrap(input) { return select(input); }
      function Screen({ route }) {
        const envelope = { payload: route.params.secret };
        const selected = unwrap(envelope);
        AsyncStorage.setItem('value', selected);
      }
    `,
      "summary-field-flow.tsx",
    );
    assert(
      fieldFlow.diagnostics.some((d) => d.ruleId === "AI-TAINT-001"),
      "Function summaries preserve object-field taint through composed helpers",
    );
  }

  console.log("— Type-Aware Semantics and Mobile Configuration");
  {
    const semanticRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "code-verifier-types-"),
    );
    const semanticFile = path.join(semanticRoot, "promises.ts");
    fs.writeFileSync(
      semanticFile,
      `
      async function check(): Promise<boolean> { return true; }
      let stored: Promise<boolean> | null = null;
      async function run() {
        check();
        stored = check();
        if (check()) console.log('always truthy');
        await check();
        void check();
        check().catch(handleError);
      }
    `,
    );
    const semanticVerifier = new CodeVerifier({
      semanticAnalysisIndex: SemanticAnalysisIndex.fromFiles([semanticFile]),
      projectRoot: semanticRoot,
    });
    const semanticResult = await semanticVerifier.verifyFile(semanticFile);
    assert(
      semanticResult.diagnostics.filter((d) => d.ruleId === "TYPE-001")
        .length === 1,
      "Type checker detects only the unhandled floating Promise",
    );
    assert(
      semanticResult.diagnostics.filter((d) => d.ruleId === "TYPE-002")
        .length === 1,
      "Type checker detects a Promise used as a condition",
    );
    assert(
      semanticResult.diagnostics.find((d) => d.ruleId === "TYPE-001")
        ?.severity === "MEDIUM",
      "Floating promises report at MEDIUM so idiomatic fire-and-forget stays advisory",
    );
    assert(
      semanticResult.checks.some(
        (check) => check.id === "type-semantics" && check.status === "PASSED",
      ),
      "TypeScript semantic stage is visible and complete",
    );

    const refreshFile = path.join(semanticRoot, "refresh.ts");
    fs.writeFileSync(
      refreshFile,
      `let refreshPromise: Promise<boolean> | null = null;
       declare function performRefresh(): Promise<boolean>;
       function refreshAuth(): Promise<boolean> {
         if (refreshPromise === null) {
           refreshPromise = performRefresh().finally(() => { refreshPromise = null; }).catch(() => false);
         }
         return refreshPromise;
       }
       void refreshAuth();`,
    );
    const refreshVerifier = new CodeVerifier({
      semanticAnalysisIndex: SemanticAnalysisIndex.fromFiles([refreshFile]),
      projectRoot: semanticRoot,
    });
    const refreshResult = await refreshVerifier.verifyFile(refreshFile);
    assert(
      !refreshResult.diagnostics.some((d) => d.ruleId === "TYPE-001"),
      "Promise rejection handling inside an assignment is recognized",
    );

    const memoFile = path.join(semanticRoot, "memo.ts");
    fs.writeFileSync(
      memoFile,
      `let runtimePromise: Promise<void> | undefined;
       async function openRuntime(): Promise<void> {}
       function ensureRuntime(): void {
         runtimePromise ??= openRuntime();
       }
       ensureRuntime();`,
    );
    const memoVerifier = new CodeVerifier({
      semanticAnalysisIndex: SemanticAnalysisIndex.fromFiles([memoFile]),
      projectRoot: semanticRoot,
    });
    const memoResult = await memoVerifier.verifyFile(memoFile);
    assert(
      !memoResult.diagnostics.some((d) => d.ruleId === "TYPE-001"),
      "Logical-assignment promise memoization (??=) is not a floating promise",
      memoResult.diagnostics.map((d) => d.ruleId).join(", "),
    );

    const actFile = path.join(semanticRoot, "act-test.tsx");
    const actTypesFile = path.join(
      semanticRoot,
      "node_modules/@testing-library/react/index.d.ts",
    );
    fs.mkdirSync(path.dirname(actTypesFile), { recursive: true });
    fs.writeFileSync(
      actTypesFile,
      `export function act<T>(callback: () => T | Promise<T>): Promise<T>;`,
    );
    fs.writeFileSync(
      actFile,
      `import { act } from "@testing-library/react";
       declare const result: any;
       act(() => result.current.addItem({ id: "p-1" }));
       act(async () => { await Promise.resolve(); });`,
    );
    const actVerifier = new CodeVerifier({
      semanticAnalysisIndex: SemanticAnalysisIndex.fromFiles([
        actFile,
        actTypesFile,
      ]),
      projectRoot: semanticRoot,
    });
    const actResult = await actVerifier.verifyFile(actFile);
    assert(
      actResult.diagnostics.filter((d) => d.ruleId === "TYPE-001").length === 1,
      "Synchronous testing act is clean while unawaited async act is flagged",
      actResult.diagnostics.map((d) => `${d.ruleId}:${d.loc.start.line}`).join(", "),
    );

    const reactNodeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "code-verifier-reactnode-"),
    );
    const reactNodeFile = path.join(reactNodeRoot, "union.ts");
    fs.writeFileSync(
      reactNodeFile,
      `
      // Mirrors React 19's ReactNode: a wide union with an ancillary Promise.
      type ReactNode =
        | string
        | number
        | boolean
        | null
        | undefined
        | Promise<string>;
      declare const fallback: ReactNode | ((props: { x: number }) => ReactNode);
      declare const maybePromise: Promise<boolean> | undefined;
      async function run() {
        if (fallback) console.log('rendering');
        while (fallback) console.log('looping');
        if (maybePromise) console.log('always truthy when defined');
      }
    `,
    );
    const reactNodeVerifier = new CodeVerifier({
      semanticAnalysisIndex: SemanticAnalysisIndex.fromFiles([reactNodeFile]),
      projectRoot: reactNodeRoot,
    });
    const reactNodeResult = await reactNodeVerifier.verifyFile(reactNodeFile);
    const reactNodeConditions = reactNodeResult.diagnostics.filter(
      (d) => d.ruleId === "TYPE-002",
    );
    assert(
      reactNodeConditions.length === 1 &&
        reactNodeConditions[0].codeSnippet === "maybePromise",
      "Wide UI unions with an ancillary Promise member (React 19 ReactNode) do not trigger TYPE-002, but Promise | undefined still does",
    );
    assert(
      reactNodeResult.diagnostics.some(
        (d) => d.ruleId === "TYPE-002" && d.codeSnippet === "maybePromise",
      ),
      "Promise | undefined conditions still trigger TYPE-002",
    );

    const mobileRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "code-verifier-mobile-"),
    );
    fs.mkdirSync(path.join(mobileRoot, "android"), { recursive: true });
    fs.mkdirSync(path.join(mobileRoot, "ios"), { recursive: true });
    fs.writeFileSync(
      path.join(mobileRoot, "app.json"),
      JSON.stringify({
        expo: {
          android: {
            allowBackup: true,
            usesCleartextTraffic: true,
            permissions: ["READ_SMS"],
          },
          ios: {
            infoPlist: {
              NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
              UIFileSharingEnabled: true,
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(mobileRoot, "android", "AndroidManifest.xml"),
      `
      <manifest><application android:allowBackup="false" android:usesCleartextTraffic="false" android:debuggable="true">
        <service android:name=".SyncService" android:exported="true" />
      </application></manifest>
    `,
    );
    fs.writeFileSync(
      path.join(mobileRoot, "ios", "Info.plist"),
      `
      <plist><dict><key>NSAppTransportSecurity</key><dict>
        <key>NSAllowsArbitraryLoads</key><false/>
      </dict></dict></plist>
    `,
    );
    const mobileResults = verifyMobileConfigs([mobileRoot], {
      projectRoot: mobileRoot,
    });
    const mobileDiagnostics = mobileResults.flatMap(
      (result) => result.diagnostics,
    );
    assert(
      mobileDiagnostics.some((d) => d.ruleId === "MOB-001"),
      "Detects enabled Expo Android backup",
    );
    assert(
      mobileDiagnostics.filter((d) => d.ruleId === "MOB-002").length === 2,
      "Detects Expo Android cleartext and iOS global ATS opt-out",
    );
    assert(
      mobileDiagnostics.some((d) => d.ruleId === "MOB-003"),
      "Detects unprotected exported Android component",
    );
    assert(
      ["MOB-004", "MOB-005", "MOB-006"].every((rule) =>
        mobileDiagnostics.some((finding) => finding.ruleId === rule),
      ),
      "Detects debuggable apps, iOS document sharing, and high-risk Android permissions",
    );
    assert(
      mobileResults.every((result) => result.checks[0].status === "PASSED"),
      "Cleanly parses Expo, Android, and iOS configuration formats",
    );

    const launcherRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "code-verifier-launcher-"),
    );
    fs.mkdirSync(path.join(launcherRoot, "android"), { recursive: true });
    fs.writeFileSync(
      path.join(launcherRoot, "android", "AndroidManifest.xml"),
      `
      <manifest><application>
        <activity android:name=".MainActivity" android:exported="true">
          <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
          </intent-filter>
        </activity>
        <activity android:name=".AdminPanelActivity" android:exported="true" />
      </application></manifest>
    `,
    );
    const launcherDiagnostics = verifyMobileConfigs([launcherRoot], {
      projectRoot: launcherRoot,
    }).flatMap((result) => result.diagnostics);
    assert(
      !launcherDiagnostics.some(
        (d) =>
          d.ruleId === "MOB-003" &&
          (d.codeSnippet?.includes("MainActivity") ?? false),
      ),
      "Exempts the launcher entry activity from MOB-003",
    );
    assert(
      launcherDiagnostics.some(
        (d) =>
          d.ruleId === "MOB-003" &&
          (d.codeSnippet?.includes("AdminPanelActivity") ?? false),
      ),
      "Still flags exported non-launcher activities without permission",
    );

    const backupRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "code-verifier-backup-"),
    );
    fs.mkdirSync(path.join(backupRoot, "android"), { recursive: true });
    fs.writeFileSync(
      path.join(backupRoot, "android", "AndroidManifest.xml"),
      `
      <manifest><application android:allowBackup="true"
        android:fullBackupContent="@xml/backup_rules"
        android:dataExtractionRules="@xml/extraction_rules">
      </application></manifest>
    `,
    );
    const backupFinding = verifyMobileConfigs([backupRoot], {
      projectRoot: backupRoot,
    })
      .flatMap((result) => result.diagnostics)
      .find((d) => d.ruleId === "MOB-001");
    assert(
      backupFinding !== undefined && backupFinding.severity === "LOW",
      "Downgrades manifest backup findings when scoped exclusion rules are configured",
    );

    const plainRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "code-verifier-plainbackup-"),
    );
    fs.mkdirSync(path.join(plainRoot, "android"), { recursive: true });
    fs.writeFileSync(
      path.join(plainRoot, "android", "AndroidManifest.xml"),
      `
      <manifest><application android:allowBackup="true"></application></manifest>
    `,
    );
    const plainFinding = verifyMobileConfigs([plainRoot], {
      projectRoot: plainRoot,
    })
      .flatMap((result) => result.diagnostics)
      .find((d) => d.ruleId === "MOB-001");
    assert(
      plainFinding !== undefined && plainFinding.severity === "MEDIUM",
      "Keeps manifest backup findings at MEDIUM without scoped exclusion rules",
    );

    const debugVariantRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "code-verifier-debugvariant-"),
    );
    fs.mkdirSync(
      path.join(debugVariantRoot, "android", "app", "src", "debug"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        debugVariantRoot,
        "android",
        "app",
        "src",
        "debug",
        "AndroidManifest.xml",
      ),
      `
      <manifest><application android:usesCleartextTraffic="true" android:debuggable="true"></application></manifest>
    `,
    );
    const debugDiagnostics = verifyMobileConfigs([debugVariantRoot], {
      projectRoot: debugVariantRoot,
    }).flatMap((result) => result.diagnostics);
    const debugCleartext = debugDiagnostics.find((d) => d.ruleId === "MOB-002");
    const debugDebuggable = debugDiagnostics.find(
      (d) => d.ruleId === "MOB-004",
    );
    assert(
      debugCleartext !== undefined && debugCleartext.severity === "LOW",
      "Reports debug-variant cleartext overlay at advisory LOW",
    );
    assert(
      debugDebuggable !== undefined && debugDebuggable.severity === "LOW",
      "Reports debug-variant debuggable overlay at advisory LOW",
    );

    const mainCleartextRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "code-verifier-maincleartext-"),
    );
    fs.mkdirSync(
      path.join(mainCleartextRoot, "android", "app", "src", "main"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        mainCleartextRoot,
        "android",
        "app",
        "src",
        "main",
        "AndroidManifest.xml",
      ),
      `
      <manifest><application android:usesCleartextTraffic="true"></application></manifest>
    `,
    );
    const mainCleartext = verifyMobileConfigs([mainCleartextRoot], {
      projectRoot: mainCleartextRoot,
    })
      .flatMap((result) => result.diagnostics)
      .find((d) => d.ruleId === "MOB-002");
    assert(
      mainCleartext !== undefined && mainCleartext.severity === "HIGH",
      "Keeps main-variant cleartext findings at HIGH",
    );

    console.log("— Expo Router and Native Module Consistency");
    {
      const routeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "code-verifier-routes-"),
      );
      const routeFiles: Array<{
        rel: string;
        body: string;
        expectFinding: boolean;
        note: string;
      }> = [
        {
          rel: "src/app/marketplace/post.tsx",
          body: "export function Post() { return null; }\n",
          expectFinding: true,
          note: "route without default export is flagged",
        },
        {
          rel: "src/app/_layout.tsx",
          body: "export default function Layout() { return null; }\n",
          expectFinding: false,
          note: "layout with default export passes",
        },
        {
          rel: "src/app/_components/hidden.tsx",
          body: "export function Hidden() { return null; }\n",
          expectFinding: false,
          note: "underscore directory is not a route",
        },
        {
          rel: "src/app/search+api.ts",
          body: "export async function GET() { return new Response(); }\n",
          expectFinding: false,
          note: "+api route exports method handlers, not a component",
        },
        {
          rel: "src/app/index.ts",
          body: "export { default } from './Home';\n",
          expectFinding: false,
          note: "re-export satisfies the default export requirement",
        },
        {
          rel: "src/components/plain.tsx",
          body: "export function Plain() { return null; }\n",
          expectFinding: false,
          note: "files outside app/ are not routes",
        },
        {
          rel: "src/app/settings.test.tsx",
          body: "export function SettingsTest() { return null; }\n",
          expectFinding: false,
          note: "test files inside app/ are ignored",
        },
      ];
      for (const item of routeFiles) {
        fs.mkdirSync(path.join(routeRoot, path.dirname(item.rel)), {
          recursive: true,
        });
        fs.writeFileSync(path.join(routeRoot, item.rel), item.body);
      }
      const routeVerifier = new CodeVerifier({ projectRoot: routeRoot });
      for (const item of routeFiles) {
        const result = await routeVerifier.verifyFile(
          path.join(routeRoot, item.rel),
        );
        const flagged = result.diagnostics.some((d) => d.ruleId === "NAV-001");
        assert(
          flagged === item.expectFinding,
          `NAV-001: ${item.note}`,
          `expected ${item.expectFinding ? "a finding" : "no finding"} for ${item.rel}`,
        );
      }

      const staleRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "code-verifier-stale-"),
      );
      fs.mkdirSync(
        path.join(staleRoot, "node_modules", "expo-fake-picker", "ios"),
        { recursive: true },
      );
      fs.writeFileSync(
        path.join(
          staleRoot,
          "node_modules",
          "expo-fake-picker",
          "ios",
          "ExpoFakePicker.podspec",
        ),
        `require 'json'\nPod::Spec.new do |s|\n  s.name           = 'ExpoFakePicker'\nend\n`,
      );
      fs.mkdirSync(path.join(staleRoot, "ios"), { recursive: true });
      fs.writeFileSync(
        path.join(staleRoot, "ios", "Podfile.lock"),
        'PODS:\n  - "UnrelatedPod (1.0.0)"\n',
      );
      fs.mkdirSync(path.join(staleRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(staleRoot, "src", "App.tsx"),
        `import * as Picker from 'expo-fake-picker';\nexport default Picker;\n`,
      );
      const staleResults = verifyNativeConsistency([staleRoot], {
        projectRoot: staleRoot,
      });
      assert(
        staleResults.length === 1 &&
          staleResults[0].filePath.endsWith("ios/Podfile.lock"),
        "NAT-001 anchors its result on the Podfile.lock",
      );
      const staleFinding = staleResults
        .flatMap((result) => result.diagnostics)
        .find((d) => d.ruleId === "NAT-001");
      assert(
        staleFinding !== undefined,
        "NAT-001 flags a JS-imported package whose pod is absent from Podfile.lock",
      );
      assert(
        staleFinding?.message.includes("'ExpoFakePicker'") === true &&
          staleFinding?.message.includes("expo-fake-picker") === true,
        "NAT-001 names both the package and its undeclared pod",
      );
      assert(
        staleFinding?.explanation.includes("src/App.tsx") === true,
        "NAT-001 cites the importing source file",
      );

      const linkedRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "code-verifier-linked-"),
      );
      fs.mkdirSync(
        path.join(linkedRoot, "node_modules", "expo-fake-picker", "ios"),
        { recursive: true },
      );
      fs.writeFileSync(
        path.join(
          linkedRoot,
          "node_modules",
          "expo-fake-picker",
          "ios",
          "ExpoFakePicker.podspec",
        ),
        `Pod::Spec.new do |s|\n  s.name = 'ExpoFakePicker'\nend\n`,
      );
      fs.mkdirSync(path.join(linkedRoot, "ios"), { recursive: true });
      fs.writeFileSync(
        path.join(linkedRoot, "ios", "Podfile.lock"),
        'PODS:\n  - "ExpoFakePicker (0.1.0)"\n  - "UnrelatedPod (1.0.0)"\n',
      );
      fs.mkdirSync(path.join(linkedRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(linkedRoot, "src", "App.tsx"),
        `import 'expo-fake-picker';\n`,
      );
      const linkedDiagnostics = verifyNativeConsistency([linkedRoot], {
        projectRoot: linkedRoot,
      }).flatMap((result) => result.diagnostics);
      assert(
        linkedDiagnostics.length === 0,
        "NAT-001 stays silent when the imported pod is already linked",
      );

      const jsOnlyRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "code-verifier-jsonly-"),
      );
      fs.mkdirSync(path.join(jsOnlyRoot, "node_modules", "tiny-lib"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(jsOnlyRoot, "node_modules", "tiny-lib", "package.json"),
        '{"name":"tiny-lib","version":"1.0.0"}\n',
      );
      fs.mkdirSync(path.join(jsOnlyRoot, "ios"), { recursive: true });
      fs.writeFileSync(
        path.join(jsOnlyRoot, "ios", "Podfile.lock"),
        'PODS:\n  - "SomePod (1.0)"\n',
      );
      fs.mkdirSync(path.join(jsOnlyRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(jsOnlyRoot, "src", "App.tsx"),
        `import { fmt } from 'tiny-lib';\n`,
      );
      const jsOnlyDiagnostics = verifyNativeConsistency([jsOnlyRoot], {
        projectRoot: jsOnlyRoot,
      }).flatMap((result) => result.diagnostics);
      assert(
        jsOnlyDiagnostics.length === 0,
        "NAT-001 ignores packages that ship no iOS podspec",
      );

      const disabledRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "code-verifier-natdisable-"),
      );
      fs.mkdirSync(
        path.join(disabledRoot, "node_modules", "expo-fake-picker", "ios"),
        { recursive: true },
      );
      fs.writeFileSync(
        path.join(
          disabledRoot,
          "node_modules",
          "expo-fake-picker",
          "ios",
          "ExpoFakePicker.podspec",
        ),
        `Pod::Spec.new do |s|\n  s.name = 'ExpoFakePicker'\nend\n`,
      );
      fs.mkdirSync(path.join(disabledRoot, "ios"), { recursive: true });
      fs.writeFileSync(
        path.join(disabledRoot, "ios", "Podfile.lock"),
        'PODS:\n  - "UnrelatedPod (1.0.0)"\n',
      );
      fs.mkdirSync(path.join(disabledRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(disabledRoot, "src", "App.tsx"),
        `import 'expo-fake-picker';\n`,
      );
      const disabledDiagnostics = verifyNativeConsistency([disabledRoot], {
        projectRoot: disabledRoot,
        disabledRules: ["NAT"],
      }).flatMap((result) => result.diagnostics);
      assert(
        disabledDiagnostics.length === 0,
        "NAT-001 respects rule-family disabling",
      );
    }

    const deployRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "code-verifier-deploy-"),
    );
    fs.mkdirSync(path.join(deployRoot, ".github", "workflows"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(deployRoot, ".github", "workflows", "ci.yml"),
      `
      permissions: write-all
      jobs:
        test:
          steps:
            - uses: actions/checkout@v4
    `,
    );
    fs.writeFileSync(
      path.join(deployRoot, "Dockerfile"),
      `FROM node:22\nARG API_TOKEN\nRUN npm ci\n`,
    );
    fs.writeFileSync(
      path.join(deployRoot, "deployment.yaml"),
      `
      apiVersion: apps/v1
      kind: Deployment
      spec:
        template:
          spec:
            hostNetwork: true
            containers:
              - name: api
                securityContext:
                  allowPrivilegeEscalation: true
    `,
    );
    fs.writeFileSync(
      path.join(deployRoot, "main.tf"),
      `
      resource "aws_security_group" "admin" {
        ingress {
          from_port = 22
          to_port = 22
          protocol = "tcp"
          cidr_blocks = ["0.0.0.0/0"]
        }
      }
    `,
    );
    const deployment = verifyDeploymentConfigs([deployRoot], {
      projectRoot: deployRoot,
    });
    const deployDiagnostics = deployment.flatMap(
      (result) => result.diagnostics,
    );
    assert(
      ["SUP-001", "SUP-002", "SUP-003", "SUP-004"].every((rule) =>
        deployDiagnostics.some((finding) => finding.ruleId === rule),
      ),
      "Detects unpinned actions, broad permissions, Docker secrets, and root runtime",
    );
    assert(
      ["IAC-001", "IAC-002", "IAC-003"].every((rule) =>
        deployDiagnostics.some((finding) => finding.ruleId === rule),
      ),
      "Detects Kubernetes privilege hazards and public Terraform administrative ingress",
    );

    const cacheFile = path.join(deployRoot, "cache.json");
    const cache = new ScanCache(cacheFile);
    cache.set("result", mobileResults[0]);
    cache.save();
    assert(
      new ScanCache(cacheFile).get("result")?.filePath ===
        mobileResults[0].filePath,
      "Persistent scan cache round-trips verification results",
    );
    const signature = projectSignature([semanticFile]);
    assert(
      fileCacheKey(semanticFile, signature, "options") ===
        fileCacheKey(semanticFile, signature, "options"),
      "Cache keys are deterministic",
    );
    const scheduled = await mapWithConcurrency(
      [3, 1, 2],
      2,
      async (value) => value * 2,
    );
    assert(
      scheduled.join(",") === "6,2,4",
      "Concurrent scan pool preserves deterministic result order",
    );
  }

  console.log("— CI Governance and Baselines");
  {
    const source = `export function run(req: any) { exec(req.body.command); }`;
    const first = await new CodeVerifier({
      projectRoot: "/checkout-a",
    }).verifyCode(source, "/checkout-a/src/run.ts");
    const shifted = await new CodeVerifier({
      projectRoot: "/checkout-b",
    }).verifyCode(`\n\n${source}`, "/checkout-b/src/run.ts");
    const firstFinding = first.diagnostics.find((d) => d.ruleId === "SEC-007")!;
    const shiftedFinding = shifted.diagnostics.find(
      (d) => d.ruleId === "SEC-007",
    )!;
    assert(
      firstFinding.fingerprint === shiftedFinding.fingerprint,
      "Fingerprint survives line shifts and checkout-root changes",
    );

    const baselineVerifier = new CodeVerifier({
      projectRoot: "/checkout-a",
      baselineFingerprints: new Set([firstFinding.fingerprint!]),
    });
    const suppressed = await baselineVerifier.verifyCode(
      source,
      "/checkout-a/src/run.ts",
    );
    assert(
      suppressed.diagnostics.length === 0 &&
        suppressed.stats.baselineSuppressed === 1 &&
        suppressed.status === "PASSED",
      "Baseline suppresses an existing finding and reports the count",
    );

    const threshold = await new CodeVerifier({ failOn: "HIGH" }).verifyCode(
      `function f(u: { a: number } | null) { return u.a; }`,
      "threshold.ts",
    );
    assert(
      threshold.diagnostics.some((d) => d.severity === "MEDIUM") &&
        threshold.status === "PASSED",
      "HIGH failure threshold keeps MEDIUM findings advisory",
    );
    const lowThreshold = await new CodeVerifier({ failOn: "LOW" }).verifyCode(
      `function f() { debugger; }`,
      "threshold-low.ts",
    );
    assert(
      lowThreshold.status === "FAILED",
      "LOW failure threshold blocks LOW findings",
    );

    const ordered = await verifier.verifyCode(
      `function f() { debugger; }\nconst apiUrl = 'http://private.example.dev';`,
      "ordered.ts",
    );
    assert(
      ordered.diagnostics.every(
        (item, index, items) =>
          index === 0 || items[index - 1].loc.start.line <= item.loc.start.line,
      ),
      "Diagnostics are emitted in deterministic source order",
    );

    const sarif = JSON.parse(formatSARIF([first]));
    assert(
      sarif.runs[0].results[0].partialFingerprints.codeVerifierFingerprint
        .length === 64,
      "SARIF includes stable partial fingerprints",
    );

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-verifier-"));
    const baselinePath = path.join(tempRoot, "baseline.json");
    writeBaseline(baselinePath, [firstFinding, firstFinding]);
    assert(
      loadBaseline(baselinePath).size === 1,
      "Baseline files round-trip and deduplicate fingerprints",
    );
    fs.writeFileSync(
      path.join(tempRoot, ".codeverifier.json"),
      JSON.stringify({ failOn: "URGENT", typo: true }),
    );
    const invalidConfig = loadConfig(tempRoot);
    assert(
      invalidConfig.errors.length === 2,
      "Invalid and unknown configuration values are rejected",
    );
  }

  // =========================================================================
  // Phase 2A: Test Generation from Static Facts
  // =========================================================================
  console.log("— Phase 2A: Test Generation");
  {
    // 1. Mock Synthesizer for well-known packages
    const codeWithNav = `
      import { useNavigation, useRoute } from '@react-navigation/native';
      import { useRouter } from 'expo-router';
      import AsyncStorage from '@react-native-async-storage/async-storage';
      import { WebView } from 'react-native-webview';
      import { login, fetchUser } from './api';
      import unknownPkg from 'unknown-library';

      export function Screen() {}
    `;
    const { ast: navAst } = parseSourceCode(codeWithNav, "Screen.tsx");
    const jestMocks = synthesizeMocks(navAst, "jest");
    const jestMockCode = generateMockCode(jestMocks, "jest");

    assert(
      jestMockCode.includes("jest.mock('@react-navigation/native'") &&
        jestMockCode.includes("useNavigation"),
      "Mock synthesizer generates Jest mocks for @react-navigation/native",
    );
    assert(
      jestMockCode.includes("jest.mock('expo-router'") &&
        jestMockCode.includes("useRouter"),
      "Mock synthesizer generates Jest mocks for expo-router",
    );
    assert(
      jestMockCode.includes("jest.mock('@react-native-async-storage/async-storage'") &&
        jestMockCode.includes("getItem: jest.fn"),
      "Mock synthesizer generates default export mock for AsyncStorage",
    );
    assert(
      jestMockCode.includes("jest.mock('react-native-webview'"),
      "Mock synthesizer generates mock for react-native-webview",
    );
    assert(
      jestMockCode.includes("jest.mock('./api'") &&
        jestMockCode.includes("login: jest.fn()") &&
        jestMockCode.includes("fetchUser: jest.fn()"),
      "Mock synthesizer generates named mocks for relative imports",
    );
    assert(
      jestMockCode.includes("jest.mock('unknown-library'"),
      "Mock synthesizer handles unknown 3rd party packages with fallback placeholder",
    );

    // Vitest mocks
    const vitestMocks = synthesizeMocks(navAst, "vitest");
    const vitestMockCode = generateMockCode(vitestMocks, "vitest");
    assert(
      vitestMockCode.includes("vi.mock('@react-navigation/native'") &&
        vitestMockCode.includes("vi.fn()"),
      "Mock synthesizer generates Vitest mocks with vi.mock/vi.fn",
    );

    // 2. Framework Auto-detection
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-detect-"));
    fs.writeFileSync(
      path.join(testDir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }),
    );
    assert(
      detectFramework(testDir) === "vitest",
      "detectFramework identifies Vitest from devDependencies",
    );

    fs.writeFileSync(
      path.join(testDir, "package.json"),
      JSON.stringify({ dependencies: { "react-native": "0.74.0", jest: "^29.0.0" } }),
    );
    assert(
      detectFramework(testDir) === "jest",
      "detectFramework identifies Jest for React Native projects",
    );

    // 3. Nullability Test Generation (AI-NULL-001)
    const nullCode = `
      export function getUser(id: string) {
        const user: any = null;
        return user.name;
      }
    `;
    const genNullTest = await generateTestsForFile(
      "src/getUser.ts",
      { framework: "jest", mode: "directory" },
      nullCode,
    );
    assert(
      genNullTest.content.includes("should handle null") &&
        genNullTest.content.includes("getUser") &&
        genNullTest.content.includes("AI-NULL-001"),
      "NullabilityStrategy generates null handling test for AI-NULL-001",
    );
    assert(
      (() => {
        try {
          parseSourceCode(genNullTest.content, "getUser.test.ts");
          return true;
        } catch {
          return false;
        }
      })(),
      "Generated nullability test is syntactically valid TypeScript",
    );

    // 4. Component Contract Test Generation (COMP-001)
    const compContractCode = `
      import React from 'react';
      import { UserCard } from './UserCard';
      export function Page() {
        return <UserCard />;
      }
    `;
    const genCompTest = await generateTestsForFile(
      "src/Page.tsx",
      { framework: "jest", mode: "directory" },
      compContractCode,
    );
    assert(
      genCompTest.content.includes("describe('Page'") ||
        genCompTest.content.includes("describe('Page.test'"),
      "ComponentContractStrategy generates test file for component consumer",
    );

    // 5. End-to-end Test Generation on VulnerableScreen.tsx
    const vulnTest = await generateTestsForFile("samples/VulnerableScreen.tsx", {
      framework: "jest",
      mode: "directory",
    });
    assert(
      vulnTest.testCases.length >= 3,
      "generateTestsForFile on samples/VulnerableScreen.tsx catches multiple findings",
    );
    assert(
      vulnTest.content.includes("AsyncStorage") &&
        vulnTest.content.includes("RN-SEC-001") &&
        vulnTest.content.includes("AsyncStorage.setItem") &&
        vulnTest.content.includes("AI-NULL-001") &&
        vulnTest.content.includes("AI-TAINT-001"),
      "Generated test for VulnerableScreen covers security (setItem), nullability, and taint findings",
    );
    assert(
      (() => {
        try {
          parseSourceCode(vulnTest.content, "VulnerableScreen.test.tsx");
          return true;
        } catch {
          return false;
        }
      })(),
      "Generated VulnerableScreen test is 100% syntactically valid TypeScript/JSX",
    );

    // 6. Multi-file Directory Generation with Options
    const outDir = path.join(testDir, "generated-tests");
    const multiResults = await generateTests(["samples/VulnerableScreen.tsx"], {
      outputDir: outDir,
      framework: "jest",
      mode: "directory",
      includeSetup: true,
    });
    assert(
      multiResults.length === 1 &&
        multiResults[0].sourceFile.includes("VulnerableScreen.tsx"),
      "generateTests produces generated test results for target files",
    );

    // 7. RaceConditionStrategy exercises target component
    const raceFinding: any = {
      ruleId: "RACE-001",
      message: "Potential race condition in asynchronous state update",
      severity: "HIGH",
      confidence: 0.85,
      loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
    };
    const raceContext: any = {
      sourceFile: "/app/FeedScreen.tsx",
      code: "export function FeedScreen({ category }: { category: string }) { return null; }",
      ast: parseSourceCode(
        "export function FeedScreen({ category }: { category: string }) { return null; }",
        "FeedScreen.tsx",
      ).ast,
      findings: [raceFinding],
      contracts: [],
      functionSummaries: [],
      framework: "jest",
    };
    const raceTests = RaceConditionStrategy.generate(raceContext, raceFinding);
    assert(
      raceTests.length > 0 &&
        raceTests[0].body.includes("<FeedScreen") &&
        raceTests[0].body.includes("rerender"),
      "RaceConditionStrategy renders the component and exercises concurrent updates",
    );

    // 8. AsyncPatternStrategy exercises target component error pathways
    const asyncFinding: any = {
      ruleId: "ASYNC-001",
      message: "Unhandled promise rejection in async action",
      severity: "HIGH",
      confidence: 0.85,
      loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
    };
    const asyncTests = AsyncPatternStrategy.generate(raceContext, asyncFinding);
    assert(
      asyncTests.length > 0 &&
        asyncTests[0].body.includes("<FeedScreen") &&
        asyncTests[0].body.includes("toJSON"),
      "AsyncPatternStrategy renders the component to verify graceful error handling",
    );

    // 9. Re-export mock synthesis
    const reExportCode = `
      export { Button, Badge } from './ui-components';
    `;
    const reExportAst = parseSourceCode(reExportCode, "index.ts").ast;
    const reExportMocks = synthesizeMocks(reExportAst, "jest");
    const reExportMockCode = generateMockCode(reExportMocks, "jest");
    assert(
      reExportMockCode.includes("jest.mock('./ui-components'") &&
        reExportMockCode.includes("Button: jest.fn()") &&
        reExportMockCode.includes("Badge: jest.fn()"),
      "Mock synthesizer captures export ... from re-exports",
    );

    // 10. HTTP client wrapper test generation (no fetch.get or hardcoded password payload)
    const httpClientCode = `
      import { z } from 'zod';
      import { ApiError } from '@/api/apiError';
      import { buildEndpoint, REFRESH_TIMEOUT_MS } from '@/api/clientHelpers';
      export async function apiRequest<T = unknown>(endpoint: string, options: any = {}): Promise<T> {
        const url = buildEndpoint(endpoint, options.params);
        const response = await fetch(url, { credentials: 'include' });
        if (response.status === 401) {
          const refresh = await fetch('/api/v1/auth/refresh', { method: 'POST', signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
          if (!refresh.ok) throw new ApiError(401, 'Session expired. Please sign in again.');
          return apiRequest(endpoint, options);
        }
        if (response.status === 204) return undefined as T;
        const data = await response.json();
        if (!response.ok) throw ApiError.fromPayload(response.status, data);
        return data;
      }
    `;
    const httpClientGen = await generateTestsForFile(
      "src/api/client.ts",
      { framework: "vitest", mode: "directory" },
      httpClientCode,
    );
    assert(
      !httpClientGen.content.includes("fetch.get") &&
        !httpClientGen.content.includes("newPassword!") &&
        !httpClientGen.content.includes("vi.mock('zod'") &&
        httpClientGen.content.includes("REFRESH_TIMEOUT_MS: 1000") &&
        httpClientGen.content.includes("new Response(") &&
        httpClientGen.testCases.length >= 5,
      "generateTestsForFile generates realistic Response-based tests for HTTP fetch client wrapper without fetch.get or zod empty mock",
    );

    // 11. Set.delete / Map.get disambiguation (not misclassified as HTTP service)
    const pubSubCode = `
      const authExpiryListeners = new Set<() => void>();
      export function subscribeAuthExpiry(listener: () => void): () => void {
        authExpiryListeners.add(listener);
        return () => { authExpiryListeners.delete(listener); };
      }
      export function notifyAuthExpiry(): void {
        for (const l of authExpiryListeners) l();
      }
      export function clearAuthExpiryListeners(): void {
        authExpiryListeners.clear();
      }
    `;
    const pubSubGen = await generateTestsForFile(
      "src/api/sessionSecurity.ts",
      { framework: "vitest", mode: "directory" },
      pubSubCode,
    );
    assert(
      !pubSubGen.content.includes("authExpiryListeners.delete.mockResolvedValueOnce") &&
        pubSubGen.content.includes("subscribeAuthExpiry") &&
        pubSubGen.content.includes("notifyAuthExpiry"),
      "generateTestsForFile does not confuse Set.delete with an HTTP client DELETE method and generates pub/sub tests",
    );

    // 12. Exported Error subclass test generation
    const errorClassCode = `
      export class ApiError extends Error {
        readonly status: number;
        readonly code: string;
        readonly details?: unknown;
        constructor(status: number, message: string, code = 'API_ERROR', details?: unknown) {
          super(message);
          this.status = status;
          this.code = code;
          this.details = details;
        }
        static isApiError(err: unknown): err is ApiError {
          return err instanceof ApiError;
        }
        static fromPayload(status: number, payload: any, fallback?: string): ApiError {
          return new ApiError(status, payload?.message || fallback || 'Error');
        }
      }
    `;
    const errorClassGen = await generateTestsForFile(
      "src/api/apiError.ts",
      { framework: "vitest", mode: "directory" },
      errorClassCode,
    );
    assert(
      errorClassGen.content.includes("import { ApiError } from './apiError'") &&
        errorClassGen.content.includes("ApiError.isApiError") &&
        errorClassGen.content.includes("ApiError.fromPayload"),
      "generateTestsForFile extracts exported class declarations and generates constructor and static method tests",
    );
  }

  // =========================================================================
  // Phase 2B: Test Runner Integration & Runtime Correlation
  // =========================================================================
  console.log("— Phase 2B: Test Runner Integration & Runtime Correlation");
  {
    // 1. Trace Parser: JSONL Parsing
    const sampleJsonl = `
      {"type":"assertion_failed","testName":"should render safely","filePath":"src/Screen.tsx","ts":1000}
      {"type":"console_error","message":"Warning: setState on unmounted component","filePath":"src/Screen.tsx","ts":1001}
    `;
    const jsonlEvents = parseTraceContent(sampleJsonl);
    assert(
      jsonlEvents.length === 2 &&
        jsonlEvents[0].type === "assertion_failed" &&
        jsonlEvents[1].type === "console_error",
      "parseTraceContent parses JSONL trace streams into TraceEvent objects",
    );

    // 2. Trace Parser: Jest JSON Output Parsing
    const jestJsonOutput = JSON.stringify({
      testResults: [
        {
          name: "/app/src/LoginScreen.test.tsx",
          testResults: [
            {
              fullName: "LoginScreen should not store token in AsyncStorage",
              status: "failed",
              failureMessages: [
                "Error: expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(...)\n    at Object.<anonymous> (/app/src/LoginScreen.tsx:42:10)",
              ],
              duration: 25,
            },
          ],
          console: [
            {
              type: "error",
              message: "Unhandled promise rejection in auth call",
            },
          ],
        },
      ],
    });
    const jestEvents = parseJestOutput(jestJsonOutput);
    assert(
      jestEvents.length === 2 &&
        jestEvents[0].type === "assertion_failed" &&
        jestEvents[0].line === 42 &&
        jestEvents[1].type === "console_error",
      "parseJestOutput extracts failed assertions with stack line numbers and console errors",
    );

    // 3. Trace Parser: JUnit XML Output Parsing
    const junitXml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <testsuites>
        <testsuite name="UserScreen Tests">
          <testcase name="should handle null user safely" file="/app/src/UserScreen.tsx" line="20">
            <failure message="TypeError: Cannot read property 'name' of null">
              TypeError: Cannot read property 'name' of null
                at UserScreen (/app/src/UserScreen.tsx:20:15)
            </failure>
          </testcase>
        </testsuite>
      </testsuites>
    `;
    const junitEvents = parseJunitOutput(junitXml);
    assert(
      junitEvents.length === 1 &&
        junitEvents[0].testName === "should handle null user safely" &&
        junitEvents[0].line === 20,
      "parseJunitOutput extracts test failures with file and line metadata",
    );

    // 4. Runtime Engine: Correlation with Static Finding (RT-CONFIRM-001)
    const staticFinding1: Diagnostic = {
      id: "diag-1",
      ruleId: "RN-SEC-001",
      message: "Plaintext token stored in AsyncStorage",
      severity: "CRITICAL",
      category: "SECURITY",
      confidence: "HIGH",
      loc: { start: { line: 42, column: 0 }, end: { line: 42, column: 20 } },
      filePath: "/app/src/LoginScreen.tsx",
      explanation: "Security rule violation",
      codeSnippet: "AsyncStorage.setItem('token', t);",
      remediation: { summary: "Use SecureStore", llmPromptHint: "Use SecureStore" },
    };

    const confirmedFindings = analyzeRuntimeTraces(jestEvents, [staticFinding1]);
    const secConfirm = confirmedFindings.find((f) => f.ruleId === "RT-CONFIRM-001");
    assert(
      Boolean(secConfirm) &&
        secConfirm?.severity === "CRITICAL" &&
        secConfirm?.confirmedBy.includes("LoginScreen"),
      "Runtime engine confirms static finding as RT-CONFIRM-001 when test assertion fails",
    );

    // 5. Runtime Engine: Null Dereference Confirmation (RT-CONFIRM-002)
    const staticFindingNull: Diagnostic = {
      id: "diag-2",
      ruleId: "AI-NULL-001",
      message: "Definite null dereference on user",
      severity: "HIGH",
      category: "CORRECTNESS",
      confidence: "HIGH",
      loc: { start: { line: 20, column: 0 }, end: { line: 20, column: 15 } },
      filePath: "/app/src/UserScreen.tsx",
      explanation: "Null dereference",
      codeSnippet: "user.name",
      remediation: { summary: "Add null check", llmPromptHint: "Add null check" },
    };

    const nullConfirmed = analyzeRuntimeTraces(junitEvents, [staticFindingNull]);
    assert(
      nullConfirmed.length === 1 &&
        nullConfirmed[0].ruleId === "RT-CONFIRM-002" &&
        nullConfirmed[0].message.includes("null dereference"),
      "Runtime engine maps runtime TypeError on null to RT-CONFIRM-002",
    );

    // 6. Runtime Engine: Unhandled Rejection Confirmation (RT-CONFIRM-003)
    const rejectionEvent = [
      {
        type: "unhandled_rejection",
        testName: "async flow test",
        reason: "Network timeout in fetch",
        filePath: "/app/src/DataScreen.tsx",
        line: 15,
        ts: Date.now(),
      },
    ];
    const staticFindingAsync: Diagnostic = {
      id: "diag-3",
      ruleId: "ASYNC-001",
      message: "Unhandled promise rejection in async action",
      severity: "HIGH",
      category: "CORRECTNESS",
      confidence: "HIGH",
      loc: { start: { line: 15, column: 0 }, end: { line: 15, column: 10 } },
      filePath: "/app/src/DataScreen.tsx",
      explanation: "Missing catch handler",
      codeSnippet: "fetchData()",
      remediation: { summary: "Add catch", llmPromptHint: "Add catch" },
    };
    const asyncConfirmed = analyzeRuntimeTraces(rejectionEvent, [staticFindingAsync]);
    assert(
      asyncConfirmed.length === 1 &&
        asyncConfirmed[0].ruleId === "RT-CONFIRM-003",
      "Runtime engine maps unhandled rejection event to RT-CONFIRM-003",
    );

    // 7. Runtime Engine: New Runtime Bug Detection (RT-NEW-001)
    const unknownEvents = [
      {
        type: "assertion_failed",
        testName: "unrelated test should validate currency format",
        message: "Expected '$10.00' but got '10.00'",
        filePath: "/app/src/Format.tsx",
        ts: Date.now(),
      },
    ];
    const newFindings = analyzeRuntimeTraces(unknownEvents, []);
    assert(
      newFindings.length === 1 &&
        newFindings[0].ruleId === "RT-NEW-001" &&
        newFindings[0].staticFinding === undefined,
      "Runtime engine flags runtime failure without static counterpart as RT-NEW-001",
    );

    // 8. Jest Reporter Adapter
    const tmpTraceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-rep-"));
    const tmpTracePath = path.join(tmpTraceDir, "trace.jsonl");
    const reporter = new CodeVerifierReporter({}, { outputFile: tmpTracePath });

    reporter.onTestResult(
      { path: "/src/HomeScreen.test.tsx" },
      {
        numPassingTests: 1,
        numFailingTests: 1,
        testResults: [
          {
            fullName: "HomeScreen crashes on render",
            status: "failed",
            failureMessages: ["ReferenceError: window is not defined"],
            duration: 10,
          },
        ],
        console: [{ type: "error", message: "Console error in HomeScreen" }],
      },
    );
    reporter.onRunComplete({}, {});
    assert(
      reporter.getTraceEvents().length === 2 &&
        reporter.getResults().has("/src/HomeScreen.test.tsx"),
      "CodeVerifierReporter captures assertion failures and console errors",
    );
    assert(
      fs.existsSync(tmpTracePath) &&
        parseTraceFile(tmpTracePath).length === 2,
      "CodeVerifierReporter persists trace events to JSONL file on run completion",
    );

    // 9. Vitest Plugin Adapter
    const vitestPluginInstance = codeVerifierPlugin({ outputFile: tmpTracePath });
    assert(
      vitestPluginInstance.name === "code-verifier" &&
        typeof vitestPluginInstance.transform === "function",
      "codeVerifierPlugin returns valid Vite/Vitest plugin object",
    );
    const transformed = vitestPluginInstance.transform(
      "describe('test', () => {});",
      "/src/component.test.tsx",
    );
    assert(
      transformed.includes("unhandledRejection"),
      "Vitest plugin injects error capture preamble into test source files",
    );

    // 10. Unified LLM Formatter
    const formattedRuntime = formatRuntimeFindings(confirmedFindings);
    assert(
      formattedRuntime.includes("RT-CONFIRM") &&
        formattedRuntime.includes("Trace Evidence"),
      "formatRuntimeFindings renders markdown with severity, confirmedBy, and trace evidence",
    );

    const unifiedMarkdown = LLMFormatter.formatUnifiedReport(
      [{
        filePath: "/app/src/LoginScreen.tsx",
        status: "FAILED",
        passed: false,
        summary: "Verification failed with 1 diagnostic",
        diagnostics: [staticFinding1],
        checks: [],
        stats: {
          totalLines: 100,
          blocksAnalyzed: 5,
          rulesChecked: 10,
          executionTimeMs: 12,
          issuesCount: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
        },
      }],
      confirmedFindings,
    );
    assert(
      unifiedMarkdown.includes("Unified Report") &&
        unifiedMarkdown.includes("Runtime Verified Findings") &&
        unifiedMarkdown.includes("Static Analysis Results"),
      "LLMFormatter.formatUnifiedReport combines static diagnostics with runtime evidence",
    );

    // 11. Package Exports validation
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"),
    );
    assert(
      pkg.exports &&
        pkg.exports["./jest-reporter"] &&
        pkg.exports["./vitest-plugin"] &&
        pkg.exports["./jest-setup"],
      "package.json defines exports subpaths for all adapters",
    );

    // =========================================================================
    // Phase 2C: MCP Test-and-Fix Loop (TDR)
    // =========================================================================
    console.log("— Phase 2C: MCP Test-and-Fix Loop (TDR)");

    // 1. Session creation and persistence
    const testSessionDir = path.join(os.tmpdir(), `tdr-test-${Date.now()}`);
    setSessionDir(testSessionDir);

    const dummyFinding: Diagnostic = {
      id: "diag-tdr-1",
      ruleId: "AI-NULL-001",
      message: "Possible null dereference on user.name",
      severity: "HIGH",
      category: "CORRECTNESS",
      confidence: "HIGH",
      loc: { start: { line: 10, column: 5 }, end: { line: 10, column: 20 } },
      filePath: "/app/src/UserProfile.tsx",
      explanation: "Null dereference",
      codeSnippet: "user.name",
      remediation: { summary: "Add optional chaining", llmPromptHint: "Use user?.name" },
    };

    const dummyGeneratedTest = {
      filePath: "/app/src/__tests__/UserProfile.test.tsx",
      content: "test('handles null', () => {});",
      testCases: [],
      sourceFile: "/app/src/UserProfile.tsx",
      framework: "jest" as const,
    };

    const session = createSession(
      "/app/src/UserProfile.tsx",
      [dummyFinding],
      [dummyGeneratedTest],
    );
    assert(
      session.id.startsWith("tdr-") &&
        session.status === "tests_generated" &&
        session.originalFindings.length === 1 &&
        session.generatedTests.length === 1,
      "createSession creates session with unique ID, findings, and generated tests",
    );

    // 2. Load session from disk
    const loaded = loadSession(session.id);
    assert(
      loaded !== null &&
        loaded.id === session.id &&
        loaded.sourceFile === session.sourceFile &&
        loaded.originalFindings[0].ruleId === "AI-NULL-001",
      "loadSession retrieves persisted TDR session from disk",
    );

    // 3. Update session status and data
    const updated = updateSession(session.id, {
      status: "verified",
      fixCommit: "a1b2c3d",
    });
    assert(
      updated !== null &&
        updated.status === "verified" &&
        updated.fixCommit === "a1b2c3d",
      "updateSession modifies session and persists changes to disk",
    );

    // 4. List sessions
    const sessionList = listSessions();
    assert(
      sessionList.length >= 1 && sessionList.some((s) => s.id === session.id),
      "listSessions returns all sessions including the updated session",
    );

    // 5. verifyFix: detects successful static fix
    const vulnerableSample = `
      import React from 'react';
      export function Profile() {
        const user: any = null;
        return <div>{user.name}</div>;
      }
    `;
    const verifierInst = new CodeVerifier();
    const staticCheck = await verifierInst.verifyCode(vulnerableSample, "Profile.tsx");
    assert(
      staticCheck.diagnostics.some((d) => d.ruleId === "AI-NULL-001"),
      "verifier detects AI-NULL-001 in vulnerable sample code",
    );

    const fixedSample = `
      import React from 'react';
      export function Profile() {
        const user: any = null;
        return <div>{user?.name}</div>;
      }
    `;
    const fixResult = await verifyFix("Profile.tsx", staticCheck.diagnostics, {
      codeOverride: fixedSample,
      runTests: false,
    });
    assert(
      fixResult.fixed === true &&
        fixResult.remainingFindings.length === 0 &&
        fixResult.resolvedFindings.length >= 1,
      "verifyFix reports fixed: true and moves finding to resolvedFindings",
    );

    // 6. verifyFix: detects incomplete fix
    const unfixedSample = `
      import React from 'react';
      export function Profile() {
        const user: any = null;
        return <span>{user.name}</span>;
      }
    `;
    const unfixedResult = await verifyFix("Profile.tsx", staticCheck.diagnostics, {
      codeOverride: unfixedSample,
      runTests: false,
    });
    assert(
      unfixedResult.fixed === false &&
        unfixedResult.remainingFindings.length >= 1 &&
        unfixedResult.resolvedFindings.length === 0,
      "verifyFix reports fixed: false when finding is still present in modified code",
    );

    // 7. verifyFix: handles test command execution (passing)
    const testPassingResult = await verifyFix("Profile.tsx", staticCheck.diagnostics, {
      codeOverride: fixedSample,
      runTests: true,
      testCommand: "node -e 'process.exit(0)'",
    });
    assert(
      testPassingResult.fixed === true &&
        testPassingResult.testResult?.passed === true,
      "verifyFix verifies fix when testCommand succeeds",
    );

    // 8. verifyFix: handles test command execution (failing)
    const testFailingResult = await verifyFix("Profile.tsx", staticCheck.diagnostics, {
      codeOverride: fixedSample,
      runTests: true,
      testCommand: "node -e 'process.exit(1)'",
    });
    assert(
      testFailingResult.fixed === false &&
        testFailingResult.testResult?.passed === false,
      "verifyFix reports fixed: false when testCommand fails",
    );

    // 9. LLM Formatter: formatTDRSession and formatFixVerification
    const formattedSession = formatTDRSession(session);
    assert(
      formattedSession.includes("TDR Session:") &&
        formattedSession.includes("Source:") &&
        formattedSession.includes("Status:"),
      "formatTDRSession renders markdown summary of session metadata",
    );

    const formattedFix = formatFixVerification(fixResult);
    assert(
      formattedFix.includes("Fix Verification Result:") &&
        formattedFix.includes("Resolved Findings:"),
      "formatFixVerification renders markdown summary of fix results",
    );

    // 10. Existing test detection
    const tempSource = path.join(testSessionDir, "Widget.tsx");
    const tempTest = path.join(testSessionDir, "Widget.test.tsx");
    fs.writeFileSync(tempSource, "export function Widget() { return null; }", "utf-8");
    fs.writeFileSync(tempTest, "test('renders', () => {});", "utf-8");

    const foundTest = findExistingTestFile(tempSource);
    assert(
      foundTest === tempTest,
      "findExistingTestFile detects co-located unit test file",
    );

    const sessionWithExisting = createSession(
      tempSource,
      [],
      [dummyGeneratedTest],
    );
    assert(
      sessionWithExisting.existingTestFound === tempTest,
      "createSession records existingTestFound in session metadata",
    );

    // 11. verifyFix with projectRoot and configured verifier
    const projectVerifier = new CodeVerifier({ projectRoot: testSessionDir });
    const contextualFix = await verifyFix(tempSource, [], {
      codeOverride: "export function Widget() { return <div />; }",
      verifier: projectVerifier,
      projectRoot: testSessionDir,
      runTests: false,
    });
    assert(
      contextualFix.fixed === true,
      "verifyFix operates seamlessly with configured CodeVerifier instance and projectRoot",
    );

    // 12. Pruning and cleaning sessions
    const prunedCount = pruneSessions({ maxAgeDays: 0, maxSessions: 1 });
    assert(
      typeof prunedCount === "number",
      "pruneSessions successfully bounds session storage",
    );

    const cleanedAll = cleanAllSessions();
    assert(
      cleanedAll >= 0 && listSessions().length === 0,
      "cleanAllSessions wipes all sessions from disk",
    );

    // Reset session directory
    setSessionDir(null);
    try {
      fs.rmSync(testSessionDir, { recursive: true, force: true });
    } catch {}

    // =========================================================================
    // Phase 2D: Selective Instrumentation
    // =========================================================================
    console.log("— Phase 2D: Selective Instrumentation");

    // 1. Probe code templates for each finding type
    const nullFinding: Diagnostic = {
      id: "diag-probe-1",
      ruleId: "AI-NULL-001",
      message: "Variable user.address may be null",
      severity: "HIGH",
      category: "CORRECTNESS",
      confidence: "HIGH",
      loc: { start: { line: 42, column: 8 }, end: { line: 42, column: 20 } },
      filePath: "/test/User.ts",
      explanation: "Null dereference",
      codeSnippet: "user.address.city",
      remediation: { summary: "Null dereference check", llmPromptHint: "Check user.address" },
    };

    const nullProbe = generateProbe(nullFinding, { line: 42, column: 8 });
    assert(
      nullProbe.includes("__cv_probe_null") &&
        nullProbe.includes("Variable user.address may be null") &&
        nullProbe.includes('"L42"'),
      "generateProbe produces __cv_probe_null for AI-NULL-001 finding",
    );

    const taintFinding: Diagnostic = {
      ...nullFinding,
      id: "diag-probe-2",
      ruleId: "AI-TAINT-001",
      message: "Untrusted input flows to dangerouslySetInnerHTML",
    };
    const taintProbe = generateProbe(taintFinding, { line: 15, column: 2 });
    assert(
      taintProbe.includes("__cv_probe_taint") &&
        taintProbe.includes("Untrusted input") &&
        taintProbe.includes('"L15"'),
      "generateProbe produces __cv_probe_taint for AI-TAINT-001 finding",
    );

    const compFinding: Diagnostic = {
      ...nullFinding,
      id: "diag-probe-3",
      ruleId: "COMP-001",
      message: "Missing required prop id in UserProfile",
    };
    const compProbe = generateProbe(compFinding, { line: 20, column: 0 });
    assert(
      compProbe.includes("__cv_probe_props") &&
        compProbe.includes("Missing required prop") &&
        compProbe.includes('"L20"'),
      "generateProbe produces __cv_probe_props for COMP-001 finding",
    );

    const raceFinding: Diagnostic = {
      ...nullFinding,
      id: "diag-probe-4",
      ruleId: "RACE-001",
      message: "Unsynchronized concurrent state update",
    };
    const raceProbe = generateProbe(raceFinding, { line: 55, column: 4 });
    assert(
      raceProbe.includes("__cv_probe_async") &&
        raceProbe.includes("Unsynchronized concurrent") &&
        raceProbe.includes('"L55"'),
      "generateProbe produces __cv_probe_async for RACE-001 finding",
    );

    const asyncFinding: Diagnostic = {
      ...nullFinding,
      id: "diag-probe-5",
      ruleId: "ASYNC-001",
      message: "Unhandled promise rejection risk",
    };
    const asyncProbe = generateProbe(asyncFinding, { line: 60, column: 10 });
    assert(
      asyncProbe.includes("__cv_probe_promise") &&
        asyncProbe.includes("Unhandled promise") &&
        asyncProbe.includes('"L60"'),
      "generateProbe produces __cv_probe_promise for ASYNC-001 finding",
    );

    const serviceFinding: Diagnostic = {
      ...nullFinding,
      id: "diag-probe-6",
      ruleId: "SERVICE-001",
      message: "Unchecked HTTP fetch status response",
    };
    const serviceProbe = generateProbe(serviceFinding, { line: 88, column: 0 });
    assert(
      serviceProbe.includes("__cv_probe_fetch") &&
        serviceProbe.includes("Unchecked HTTP fetch") &&
        serviceProbe.includes('"L88"'),
      "generateProbe produces __cv_probe_fetch for SERVICE-001 finding",
    );

    const genericFinding: Diagnostic = {
      ...nullFinding,
      id: "diag-probe-7",
      ruleId: "SEC-XSS-001",
      message: "Generic security warning",
    };
    const genericProbe = generateProbe(genericFinding, { line: 99, column: 0 });
    assert(
      genericProbe.includes("__cv_probe(") &&
        genericProbe.includes("SEC-XSS-001") &&
        genericProbe.includes('"L99"'),
      "generateProbe falls back to __cv_probe for unspecified rule types",
    );

    // 2. Runtime preamble execution and event recording
    const probeSandbox: any = { console, require, setTimeout, clearTimeout };
    const runtimeFn = new Function("window", "globalThis", `${RUNTIME_PREAMBLE_CODE}; return window;`);
    const win = runtimeFn(probeSandbox, probeSandbox);

    assert(
      Array.isArray(win.__cv_probes),
      "Runtime preamble initializes window.__cv_probes array",
    );

    // Null probe tests
    win.__cv_probes.length = 0;
    win.__cv_probe_null("user.name is undefined", "L10");
    assert(
      win.__cv_probes.length === 1 &&
        win.__cv_probes[0].type === "null_dereference" &&
        win.__cv_probes[0].location === "L10",
      "__cv_probe_null records null_dereference when value is omitted/undefined",
    );

    win.__cv_probe_null("user.name is null", "L11", null);
    assert(
      win.__cv_probes.length === 2 &&
        win.__cv_probes[1].type === "null_dereference",
      "__cv_probe_null records null_dereference when value is explicitly null",
    );

    win.__cv_probe_null("user.name is valid", "L12", "Alice");
    assert(
      win.__cv_probes.length === 2,
      "__cv_probe_null does NOT record when value is non-null",
    );

    // Taint probe test
    win.__cv_probe_taint("tainted payload", "L20", "<script>alert(1)</script>");
    assert(
      win.__cv_probes.length === 3 &&
        win.__cv_probes[2].type === "taint_flow" &&
        win.__cv_probes[2].value === "<script>alert(1)</script>",
      "__cv_probe_taint records taint_flow event with captured value",
    );

    // Props probe test
    win.__cv_probe_props("UserProfile", "L30", { userId: 42 });
    assert(
      win.__cv_probes.length === 4 &&
        win.__cv_probes[3].type === "component_props" &&
        win.__cv_probes[3].value.userId === 42,
      "__cv_probe_props records component_props event with component props",
    );

    // Async probe test
    let asyncFailed = false;
    try {
      await win.__cv_probe_async("sync fail", "L40", () =>
        Promise.reject(new Error("network timeout")),
      );
    } catch {
      asyncFailed = true;
    }
    assert(
      asyncFailed &&
        win.__cv_probes.some((e: any) => e.type === "async_failure" && e.location === "L40"),
      "__cv_probe_async catches and records async_failure event on rejected promise",
    );

    // Promise probe test
    await win.__cv_probe_promise("fetch task", "L50", Promise.resolve({ ok: true }));
    assert(
      win.__cv_probes.some((e: any) => e.type === "promise_resolved" && e.location === "L50"),
      "__cv_probe_promise records promise_resolved event on fulfilled promise",
    );

    // Preamble generator with probe-output configuration
    const customPreamble = generateRuntimePreamble("/tmp/custom-traces.jsonl");
    assert(
      customPreamble.includes("/tmp/custom-traces.jsonl") &&
        customPreamble.includes("__cv_probe_output"),
      "generateRuntimePreamble injects __cv_probe_output configuration into preamble",
    );

    // 3. Selective AST Instrumentation
    const sampleCleanCode = `function add(a: number, b: number) {\n  return a + b;\n}`;
    const cleanOutput = instrumentCode(sampleCleanCode, "add.ts", []);
    assert(
      cleanOutput === sampleCleanCode,
      "instrumentCode returns unmodified code when there are no findings",
    );

    const sampleVulnCode = `
function display(user: any) {
  const name = user.profile.name;
  return name;
}
`;
    const singleFinding: Diagnostic = {
      ...nullFinding,
      loc: { start: { line: 3, column: 15 }, end: { line: 3, column: 32 } },
    };

    const instrumented = instrumentCode(sampleVulnCode, "display.ts", [singleFinding]);
    assert(
      instrumented.includes("[code-verifier] Runtime Probes Preamble") &&
        instrumented.includes("__cv_probe_null(") &&
        instrumented.includes('"L3"'),
      "instrumentCode injects runtime preamble and __cv_probe_null at flagged location",
    );

    const withoutPreamble = instrumentCode(sampleVulnCode, "display.ts", [singleFinding], {
      prependRuntime: false,
    });
    assert(
      !withoutPreamble.includes("[code-verifier] Runtime Probes Preamble") &&
        withoutPreamble.includes("__cv_probe_null("),
      "instrumentCode honors prependRuntime: false option",
    );

    // Plugin invocation compatibility (direct and Babel options)
    const directPlugin = codeVerifierInstrumentPlugin({ findings: [singleFinding] });
    assert(
      directPlugin.name === "code-verifier-instrument" && typeof directPlugin.visitor === "object",
      "codeVerifierInstrumentPlugin returns valid plugin object when passed options directly",
    );

    const babelPlugin = codeVerifierInstrumentPlugin({}, { findings: [singleFinding] });
    assert(
      babelPlugin.name === "code-verifier-instrument" && typeof babelPlugin.visitor === "object",
      "codeVerifierInstrumentPlugin returns valid plugin object when invoked via Babel plugin signature",
    );

    // Syntactic validity: execution of instrumented code
    const executableSource = `
function getCity(user) {
  var address = user.address;
  return address;
}
getCity({});
`;
    const execFinding: Diagnostic = {
      ...nullFinding,
      loc: { start: { line: 3, column: 2 }, end: { line: 3, column: 25 } },
    };
    const executableInstrumented = instrumentCode(executableSource, "getCity.js", [execFinding]);
    let executedWithoutError = false;
    try {
      const runner = new Function(executableInstrumented);
      runner();
      executedWithoutError = true;
    } catch (e) {
      executedWithoutError = false;
    }
    assert(
      executedWithoutError,
      "Instrumented code is syntactically valid and executes without errors in JavaScript runtime",
    );

    // 4. Runtime engine handling of probe events
    const probeEvents = [
      {
        type: "null_dereference",
        message: "Cannot read property 'name' of undefined",
        location: "L42",
        filePath: "/app/src/UserProfile.tsx",
        timestamp: Date.now(),
      },
      {
        type: "taint_flow",
        message: "Untrusted input reaches DOM sink",
        location: "L15",
        filePath: "/app/src/UserProfile.tsx",
        timestamp: Date.now(),
      },
      {
        type: "async_failure",
        message: "Promise rejected in loadProfile",
        location: "L88",
        filePath: "/app/src/UserProfile.tsx",
        timestamp: Date.now(),
      },
    ];

    const probeReport = analyzeRuntimeTraces(probeEvents as any, [nullFinding]);
    const nullReportFinding = probeReport.find((f: any) => f.ruleId === "RT-NULL-001");
    assert(
      nullReportFinding !== undefined &&
        nullReportFinding.severity === "HIGH" &&
        nullReportFinding.confirmedBy === "probe at L42" &&
        nullReportFinding.loc.start.line === 42,
      "analyzeRuntimeTraces correlates null_dereference probe event to RT-NULL-001 with correct line",
    );

    const taintReportFinding = probeReport.find((f: any) => f.ruleId === "RT-TAINT-001");
    assert(
      taintReportFinding !== undefined &&
        taintReportFinding.severity === "HIGH" &&
        taintReportFinding.confirmedBy === "probe at L15" &&
        taintReportFinding.loc.start.line === 15,
      "analyzeRuntimeTraces correlates taint_flow probe event to RT-TAINT-001 with correct line",
    );

    const asyncReportFinding = probeReport.find((f: any) => f.ruleId === "RT-ASYNC-001");
    assert(
      asyncReportFinding !== undefined &&
        asyncReportFinding.severity === "HIGH" &&
        asyncReportFinding.confirmedBy === "probe at L88" &&
        asyncReportFinding.loc.start.line === 88,
      "analyzeRuntimeTraces correlates async_failure probe event to RT-ASYNC-001 with correct line",
    );

    // 5. CLI end-to-end integration test
    const tempCliDir = path.join(os.tmpdir(), `cv-cli-inst-${Date.now()}`);
    const tempSrcDir = path.join(tempCliDir, "src");
    const tempOutDir = path.join(tempCliDir, "out");
    fs.mkdirSync(tempSrcDir, { recursive: true });

    // Vulnerable file that triggers static findings
    const vulnFilePath = path.join(tempSrcDir, "Vulnerable.tsx");
    fs.writeFileSync(
      vulnFilePath,
      `import React from 'react';\nexport function Vulnerable() {\n  const user: any = null;\n  return <div>{user.name}</div>;\n}`,
      "utf-8",
    );

    // Clean file with no findings
    const cleanFilePath = path.join(tempSrcDir, "Clean.tsx");
    const cleanContent = `import React from 'react';\nexport function Clean() {\n  return <div>Clean Component</div>;\n}`;
    fs.writeFileSync(cleanFilePath, cleanContent, "utf-8");

    // Execute CLI with --instrument
    const cliScript = path.resolve(__dirname, "../src/cli.ts");
    const cliOutput = execSync(
      `npx ts-node "${cliScript}" --instrument "${tempSrcDir}" --output "${tempOutDir}"`,
      { encoding: "utf-8" },
    );

    assert(
      cliOutput.includes("Instrumented 2 file(s)"),
      "CLI --instrument logs total number of processed files",
    );

    const outVulnPath = path.join(tempOutDir, "Vulnerable.tsx");
    const outCleanPath = path.join(tempOutDir, "Clean.tsx");
    assert(
      fs.existsSync(outVulnPath) && fs.existsSync(outCleanPath),
      "CLI --instrument produces all target files in output directory",
    );

    const outVulnCode = fs.readFileSync(outVulnPath, "utf-8");
    assert(
      outVulnCode.includes("[code-verifier] Runtime Probes Preamble") &&
        outVulnCode.includes("__cv_probe_null"),
      "CLI --instrument injects probes into files with findings",
    );

    const outCleanCode = fs.readFileSync(outCleanPath, "utf-8");
    assert(
      outCleanCode === cleanContent,
      "CLI --instrument leaves files without findings completely unchanged",
    );

    try {
      fs.rmSync(tempCliDir, { recursive: true, force: true });
    } catch {}

    // =========================================================================
    // Phase 2E: LLM-Driven UI Testing
    // =========================================================================
    console.log("— Phase 2E: LLM-Driven UI Testing");

    // 1. Driver abstraction: Playwright and Detox driver implementations
    const pwDriver = await createPlaywrightDriver();
    assert(
      typeof pwDriver.navigate === "function" &&
        typeof pwDriver.click === "function" &&
        typeof pwDriver.type === "function" &&
        typeof pwDriver.screenshot === "function" &&
        typeof pwDriver.getCurrentLocation === "function" &&
        typeof pwDriver.waitFor === "function" &&
        typeof pwDriver.isVisible === "function" &&
        typeof pwDriver.getText === "function" &&
        typeof pwDriver.scrollTo === "function" &&
        typeof pwDriver.close === "function",
      "Playwright driver implements the complete UIDriver interface",
    );

    const detoxDriver = await createDetoxDriver();
    assert(
      typeof detoxDriver.navigate === "function" &&
        typeof detoxDriver.click === "function" &&
        typeof detoxDriver.type === "function" &&
        typeof detoxDriver.screenshot === "function" &&
        typeof detoxDriver.getCurrentLocation === "function" &&
        typeof detoxDriver.waitFor === "function" &&
        typeof detoxDriver.isVisible === "function" &&
        typeof detoxDriver.getText === "function" &&
        typeof detoxDriver.scrollTo === "function" &&
        typeof detoxDriver.close === "function",
      "Detox driver implements the complete UIDriver interface",
    );

    // Simulated driver interactions
    const simDriver = new SimulatedUIDriver({
      initialLocation: "/home",
      elements: {
        "#login-btn": { selector: "#login-btn", visible: true, text: "Log In" },
        "input[name='email']": { selector: "input[name='email']", visible: true, text: "", value: "" },
      },
    });

    await simDriver.navigate("/dashboard");
    assert((await simDriver.getCurrentLocation()) === "/dashboard", "UIDriver.navigate updates current location");

    assert((await simDriver.isVisible("#login-btn")) === true, "UIDriver.isVisible checks element visibility");
    assert((await simDriver.getText("#login-btn")) === "Log In", "UIDriver.getText retrieves element text");

    await simDriver.type("input[name='email']", "user@example.com");
    await simDriver.click("#login-btn");
    await simDriver.scrollTo("#footer");
    await simDriver.waitFor("#login-btn", 100);

    const shot = await simDriver.screenshot();
    assert(typeof shot === "string" && shot.startsWith("data:image/png;base64,"), "UIDriver.screenshot returns base64 PNG data");

    await simDriver.close();

    // 2. LLM Observer: Prompt Building and Response Parsing
    const testPrompt = buildObservationPrompt({
      screenshot: "data:image/png;base64,abc",
      location: "/checkout",
      previousSteps: [{ id: 1, action: "navigate to /cart", timestamp: Date.now() }],
      currentFlow: "payment_flow",
    });

    assert(
      testPrompt.includes("Current screen: /checkout") &&
        testPrompt.includes("Current flow: payment_flow") &&
        testPrompt.includes("Visual bugs") &&
        testPrompt.includes("UX bugs"),
      "buildObservationPrompt generates formatted prompt with location, flow, and categories",
    );

    // JSON response parsing
    const mockJsonResponse = JSON.stringify({
      observation: "Checkout button overlaps with billing address input field.",
      bugs: [
        {
          id: "bug-101",
          severity: "high",
          category: "visual",
          description: "Checkout button overlaps with billing address input field",
          reproductionSteps: ["Navigate to /checkout", "Scroll down to submit"],
        },
      ],
      nextAction: "click #pay-button",
    });

    const parsedJson = parseObservationResponse(mockJsonResponse);
    assert(
      parsedJson.observation.includes("Checkout button overlaps") &&
        parsedJson.bugs.length === 1 &&
        parsedJson.bugs[0].severity === "high" &&
        parsedJson.bugs[0].category === "visual" &&
        parsedJson.nextAction === "click #pay-button",
      "parseObservationResponse parses structured JSON responses into UIBug objects",
    );

    // Markdown response parsing
    const mockMdResponse = `
1. Observation: Form is submitted but no progress spinner is displayed.
2. Bugs:
- [HIGH] UX: No feedback or loading indicator after form submission
- [MEDIUM] Visual: Button text truncated on small screens
3. Next action: type input[name='search'] query
`;
    const parsedMd = parseObservationResponse(mockMdResponse);
    assert(
      parsedMd.bugs.length === 2 &&
        parsedMd.bugs[0].severity === "high" &&
        parsedMd.bugs[0].category === "ux" &&
        parsedMd.bugs[1].severity === "medium" &&
        parsedMd.bugs[1].category === "visual",
      "parseObservationResponse parses structured Markdown text format into UIBug objects",
    );

    // observeUI with mock LLM caller
    const mockDriver = new SimulatedUIDriver({ initialLocation: "/profile" });
    const llmObservation = await observeUI(mockDriver, {
      previousSteps: [],
      currentFlow: "profile_edit",
      llmCaller: async () => mockJsonResponse,
    });
    assert(
      llmObservation.bugs.length === 1 &&
        llmObservation.bugs[0].id === "bug-101" &&
        llmObservation.nextAction === "click #pay-button",
      "observeUI queries LLM caller and returns parsed observations and bugs",
    );

    // 3. Session Management
    clearUITestSessions();
    const testSession = await startUITestSession({
      framework: "playwright",
      target: "/settings",
      flows: ["account", "security"],
      driver: new SimulatedUIDriver({ initialLocation: "/settings" }),
    });

    assert(
      testSession.id.startsWith("ui-session-") &&
        testSession.status === "completed" &&
        testSession.framework === "playwright" &&
        testSession.target === "/settings" &&
        testSession.steps.length >= 2,
      "startUITestSession initializes, runs flows, and records steps",
    );

    const loadedSession = getUITestSession(testSession.id);
    assert(
      loadedSession !== null && loadedSession.id === testSession.id,
      "getUITestSession retrieves session by ID",
    );

    await stopUITestSession(testSession.id);
    assert(
      getUITestSession(testSession.id)?.status === "completed",
      "stopUITestSession finalizes session status",
    );

    // 4. Bug Reporter
    const sampleBug: UIBug = {
      id: "bug-ui-1",
      severity: "high",
      category: "visual",
      description: "Button text is truncated on small screens",
      location: "/src/components/SubmitButton.tsx",
      screenshot: "data:image/png;base64,xyz",
      reproductionSteps: ["Navigate to login screen", "Observe submit button"],
    };

    const bugSession: UITestSession = {
      id: "session-xyz",
      framework: "playwright",
      target: "/login",
      status: "completed",
      steps: [{ id: 1, action: "navigate to /login", timestamp: Date.now() }],
      bugs: [sampleBug],
      startedAt: new Date(Date.now() - 2500).toISOString(),
      completedAt: new Date().toISOString(),
    };

    const bugReport = generateBugReport(bugSession);
    assert(
      bugReport.includes("# UI Test Report") &&
        bugReport.includes("**Session:** session-xyz") &&
        bugReport.includes("**Bugs Found:** 1") &&
        bugReport.includes("### 1. [HIGH] Visual: Button text is truncated on small screens") &&
        bugReport.includes("- **Location:** /src/components/SubmitButton.tsx") &&
        bugReport.includes("- High: 1") &&
        bugReport.includes("- Critical: 0"),
      "generateBugReport produces clean Markdown report with bug details and summary counts",
    );

    // Clean session report
    const cleanBugSession: UITestSession = {
      ...bugSession,
      id: "session-clean",
      bugs: [],
    };
    const cleanReport = generateBugReport(cleanBugSession);
    assert(
      cleanReport.includes("No UI bugs detected across tested flows.") &&
        cleanReport.includes("- High: 0"),
      "generateBugReport produces clean summary when no bugs are detected",
    );

    // 5. Real Bug Detection in a Test Component
    const tempUiDir = path.join(os.tmpdir(), `cv-ui-test-${Date.now()}`);
    fs.mkdirSync(tempUiDir, { recursive: true });
    const buggyComponentFile = path.join(tempUiDir, "BuggyCard.tsx");
    fs.writeFileSync(
      buggyComponentFile,
      `import React from 'react';
export function BuggyCard() {
  return (
    <div style={{ width: 25, overflow: 'hidden' }}>
      <button style={{ width: 20 }}>Long Action Label That Truncates</button>
      <form>
        <button type="submit">Submit</button>
      </form>
    </div>
  );
}`,
      "utf-8",
    );

    const buggySession = await startUITestSession({
      framework: "playwright",
      target: buggyComponentFile,
      flows: ["initial_view"],
    });

    assert(
      buggySession.bugs.length >= 1 &&
        buggySession.bugs.some(
          (b) => b.category === "visual" || b.category === "ux" || b.category === "functional",
        ),
      "startUITestSession detects real visual/UX bugs in buggy target component",
    );

    // 6. CLI Integration: --ui-test flag execution
    const cliScriptPath = path.resolve(__dirname, "../src/cli.ts");
    let cliUiOutput = "";
    try {
      cliUiOutput = execSync(
        `npx ts-node "${cliScriptPath}" --ui-test "${buggyComponentFile}" --framework=playwright`,
        { encoding: "utf-8" },
      );
    } catch (err: any) {
      cliUiOutput = err.stdout || err.message;
    }

    assert(
      cliUiOutput.includes("UI Test Session:") &&
        cliUiOutput.includes("Bugs Found:") &&
        cliUiOutput.includes("# UI Test Report"),
      "CLI --ui-test flag executes UI test session and outputs bug report",
    );

    try {
      fs.rmSync(tempUiDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n========================================`);
  console.log(`Test Summary: ${passedCount} passed, ${failedCount} failed.`);
  console.log(`========================================\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
