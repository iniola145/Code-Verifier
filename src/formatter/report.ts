import { VerificationResult, Diagnostic } from '../types/verifier';

/**
 * Whole-project health report (CLI --format=report): findings aggregated
 * by rule and by file, so a large-repo run shows shape at a glance.
 */
export function formatReport(results: VerificationResult[]): string {
  const all = results.flatMap((r) => r.diagnostics);
  const sevOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

  const count = (sev: string) => all.filter((d) => d.severity === sev).length;

  const lines: string[] = [];
  const totalLines = results.reduce((s, r) => s + r.stats.totalLines, 0);
  const totalTime = results.reduce((s, r) => s + r.stats.executionTimeMs, 0);
  const funcs = results.reduce((s, r) => s + (r.stats.functionsAnalyzed ?? 0), 0);
  const baselineSuppressed = results.reduce((s, r) => s + (r.stats.baselineSuppressed ?? 0), 0);

  lines.push('# Project Verification Report');
  lines.push('');
  lines.push(`- Files: ${results.length}`);
  lines.push(`- Lines: ${totalLines}`);
  lines.push(`- Functions analyzed: ${funcs}`);
  lines.push(`- Status: ${projectStatus(results)}`);
  lines.push(`- Files by status: ${['PASSED', 'FAILED', 'INCOMPLETE'].map((s) => `${s}: ${results.filter((r) => r.status === s).length}`).join(' | ')}`);
  lines.push(`- Total findings: ${all.length} (${sevOrder.map((s) => `${s}: ${count(s)}`).join(' | ')})`);
  if (baselineSuppressed > 0) lines.push(`- Baseline findings suppressed: ${baselineSuppressed}`);
  const parseFailsList = results.filter((r) => r.stats.failureType === 'parse-error');
  if (parseFailsList.length > 0) {
    lines.push(`- Parse failures: ${parseFailsList.length} (verification incomplete)`);
  }
  lines.push('');

  // ---- By rule -----------------------------------------------------
  const byRule = new Map<string, { count: number; files: Set<string>; worst: string; name: string }>();
  for (const d of all) {
    const e = byRule.get(d.ruleId) ?? { count: 0, files: new Set<string>(), worst: d.severity, name: d.ruleId };
    e.count++;
    e.files.add(d.filePath);
    if (sevOrder.indexOf(d.severity) < sevOrder.indexOf(e.worst as any)) e.worst = d.severity;
    if (!byRule.has(d.ruleId)) byRule.set(d.ruleId, e);
  }
  if (byRule.size > 0) {
    lines.push('## By rule');
    lines.push('');
    lines.push('| Rule | Worst severity | Count | Files affected |');
    lines.push('|---|---|---|---|');
    const rows = [...byRule.values()].sort((a, b) =>
      sevOrder.indexOf(a.worst as any) - sevOrder.indexOf(b.worst as any) || b.count - a.count
    );
    for (const e of rows) {
      lines.push(`| ${e.name} | ${e.worst} | ${e.count} | ${e.files.size} |`);
    }
    lines.push('');
  }

  // ---- Worst files ---------------------------------------------------
  const byFile = results
    .map((r) => ({ file: r.filePath, n: r.diagnostics.filter((d) => ['CRITICAL', 'HIGH', 'MEDIUM'].includes(d.severity)).length }))
    .filter((f) => f.n > 0)
    .sort((a, b) => b.n - a.n);
  lines.push('## Worst files (blocking findings)');
  lines.push('');
  for (const f of byFile.slice(0, 15)) {
    lines.push(`- ${f.file} — ${f.n}`);
  }
  lines.push('');

  // ---- Clean files ----------------------------------------------------
  const clean = results.filter((r) => r.status === 'PASSED');
  lines.push(`Passed files: ${clean.length}/${results.length}`);
  return lines.join('\n');
}

function projectStatus(results: VerificationResult[]): string {
  if (results.some((result) => result.status === 'FAILED')) return 'FAILED';
  if (results.some((result) => result.status === 'INCOMPLETE')) return 'INCOMPLETE';
  return 'PASSED';
}
