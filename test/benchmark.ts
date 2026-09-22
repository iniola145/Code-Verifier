import { CodeVerifier } from '../src/engine';

interface Case { name: string; family: string; ruleId: string; vulnerable: string; fixed: string; }

const cases: Case[] = [
  { name: 'assignment condition', family: 'correctness', ruleId: 'LOGIC-001', vulnerable: `if (ready = load()) run();`, fixed: `ready = load(); if (ready === true) run();` },
  { name: 'missing callback return', family: 'correctness', ruleId: 'LOGIC-002', vulnerable: `const x = rows.map(row => { row.id; });`, fixed: `const x = rows.map(row => row.id);` },
  { name: 'async foreach', family: 'correctness', ruleId: 'ASYNC-001', vulnerable: `rows.forEach(async row => { await save(row); });`, fixed: `await Promise.all(rows.map(async row => save(row)));` },
  { name: 'async promise executor', family: 'correctness', ruleId: 'ASYNC-002', vulnerable: `new Promise(async resolve => resolve(await load()));`, fixed: `load();` },
  { name: 'async effect', family: 'react', ruleId: 'REACT-004', vulnerable: `useEffect(async () => { await load(); }, []);`, fixed: `useEffect(() => { void load(); }, []);` },
  { name: 'index key', family: 'react', ruleId: 'REACT-005', vulnerable: `rows.map((row, index) => <Row key={index} />);`, fixed: `rows.map(row => <Row key={row.id} />);` },
  { name: 'empty catch', family: 'reliability', ruleId: 'REL-001', vulnerable: `try { load(); } catch {}`, fixed: `try { load(); } catch (error) { report(error); }` },
  { name: 'finally return', family: 'reliability', ruleId: 'REL-002', vulnerable: `function f(){ try { return 1; } finally { return 2; } }`, fixed: `function f(){ try { return 1; } finally { cleanup(); } }` },
  { name: 'error detail leak', family: 'backend', ruleId: 'API-001', vulnerable: `res.status(500).json({ error: error.message });`, fixed: `res.status(500).json({ error: 'Internal error' });` },
  { name: 'success error status', family: 'backend', ruleId: 'API-002', vulnerable: `res.status(200).json({ error: 'missing' });`, fixed: `res.status(404).json({ error: 'missing' });` },
  { name: 'unprotected admin', family: 'backend', ruleId: 'AUTH-001', vulnerable: `app.get('/admin/users', (req, res) => res.json([]));`, fixed: `app.get('/admin/users', requireAdmin, (req, res) => res.json([]));` },
  { name: 'sensitive log', family: 'security', ruleId: 'SEC-013', vulnerable: `console.log(accessToken);`, fixed: `console.log('authenticated');` },
  { name: 'eval', family: 'security', ruleId: 'SEC-004', vulnerable: `eval(source);`, fixed: `JSON.parse(source);` },
  { name: 'command injection', family: 'security', ruleId: 'SEC-007', vulnerable: `exec(req.body.command);`, fixed: `execFile('tool', ['--safe']);` },
  { name: 'sql injection', family: 'security', ruleId: 'SEC-008', vulnerable: 'db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);', fixed: `db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);` },
  { name: 'ssrf', family: 'security', ruleId: 'SEC-009', vulnerable: `fetch(req.query.url);`, fixed: `fetch('https://api.example.com/status');` },
  { name: 'path traversal', family: 'security', ruleId: 'SEC-010', vulnerable: `readFile(req.query.path);`, fixed: `readFile('/srv/data/report.json');` },
  { name: 'weak randomness', family: 'security', ruleId: 'SEC-011', vulnerable: `const token = Math.random().toString(36);`, fixed: `const token = crypto.randomUUID();` },
  { name: 'prototype pollution', family: 'security', ruleId: 'SEC-012', vulnerable: `config[req.body.key] = value;`, fixed: `config.theme = req.body.theme;` },
  { name: 'wildcard credentialed cors', family: 'security', ruleId: 'SEC-017', vulnerable: `app.use(cors({ origin: '*', credentials: true }));`, fixed: `app.use(cors({ origin: 'https://app.example.com', credentials: true }));` },
];

async function main(): Promise<void> {
  const verifier = new CodeVerifier();
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const families = new Map<string, { tp: number; fp: number; fn: number }>();
  for (const item of cases) {
    const family = families.get(item.family) ?? { tp: 0, fp: 0, fn: 0 };
    families.set(item.family, family);
    const vulnerable = await verifier.verifyCode(item.vulnerable, `${item.name}-vulnerable.tsx`);
    const fixed = await verifier.verifyCode(item.fixed, `${item.name}-fixed.tsx`);
    if (vulnerable.diagnostics.some((finding) => finding.ruleId === item.ruleId)) { truePositive++; family.tp++; }
    else { falseNegative++; family.fn++; }
    if (fixed.diagnostics.some((finding) => finding.ruleId === item.ruleId)) { falsePositive++; family.fp++; }
  }
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  const f1 = 2 * precision * recall / Math.max(Number.EPSILON, precision + recall);
  console.log(`Benchmark: ${cases.length} vulnerable/fixed pairs`);
  console.log(`TP=${truePositive} FP=${falsePositive} FN=${falseNegative}`);
  console.log(`Precision=${(precision * 100).toFixed(1)}% Recall=${(recall * 100).toFixed(1)}% F1=${(f1 * 100).toFixed(1)}%`);
  for (const [name, counts] of [...families].sort(([a], [b]) => a.localeCompare(b))) {
    const p = counts.tp / Math.max(1, counts.tp + counts.fp);
    const r = counts.tp / Math.max(1, counts.tp + counts.fn);
    console.log(`${name}: P=${(p * 100).toFixed(1)}% R=${(r * 100).toFixed(1)}% (${counts.tp} TP, ${counts.fp} FP, ${counts.fn} FN)`);
  }
  if (precision < 0.95 || recall < 0.95) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
