import { VerificationResult, Diagnostic, ProjectVerificationResult } from '../types/verifier';
import { getRuleMetadata } from '../rules/registry';

const SEVERITY_TO_SARIF_LEVEL: Record<string, string> = {
  CRITICAL: 'error',
  HIGH: 'error',
  MEDIUM: 'warning',
  LOW: 'note',
  INFO: 'note',
};

/**
 * Emits SARIF 2.1.0 so results integrate with GitHub code scanning,
 * VS Code SARIF viewers, and CI gatekeepers.
 */
export function formatSARIF(results: VerificationResult[], projects: ProjectVerificationResult[] = []): string {
  const rulesById = new Map<string, { id: string; name: string; description: string; cweId?: string; confidence?: string; category?: string }>();

  const sarifResults = results.flatMap((result) =>
    result.diagnostics.map((diag) => {
      if (!rulesById.has(diag.ruleId)) {
        const metadata = getRuleMetadata(diag.ruleId);
        rulesById.set(diag.ruleId, {
          id: diag.ruleId,
          name: metadata?.name ?? diag.ruleId,
          description: metadata?.description ?? diag.explanation,
          cweId: diag.cweId,
          confidence: metadata?.confidence ?? diag.confidence,
          category: metadata?.category ?? diag.category,
        });
      }
      return toSarifResult(diag, result.filePath);
    })
  );

  const toolRules = [...rulesById.values()].map((r) => ({
    id: r.id,
    name: r.name,
    shortDescription: { text: r.description },
    fullDescription: { text: r.description },
    properties: {
      ...(r.cweId ? { 'security-severity': cweToSeverityScore(r.cweId), tags: [r.cweId] } : {}),
      confidence: r.confidence,
      category: r.category,
    },
  }));

  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'code-verifier',
              informationUri: 'https://github.com/code-verifier',
              rules: toolRules,
            },
          },
          invocations: [
            {
              executionSuccessful:
                results.every((result) => result.status !== 'INCOMPLETE') &&
                projects.every((project) => project.status !== 'INCOMPLETE'),
              toolExecutionNotifications: [
                ...results.flatMap((result) =>
                  result.checks
                  .filter((check) => check.status === 'INCOMPLETE')
                  .map((check) => ({
                    level: 'error',
                    message: { text: `${result.filePath}: ${check.name}: ${check.message ?? 'check incomplete'}` },
                    descriptor: { id: `CHECK-${check.id.toUpperCase()}` },
                  }))
                ),
                ...projects.flatMap((project) =>
                  project.checks
                    .filter((check) => check.status === 'INCOMPLETE')
                    .map((check) => ({
                      level: 'error',
                      message: { text: `${project.projectRoot}: ${check.name}: ${check.message ?? 'check incomplete'}` },
                      descriptor: { id: `PROJECT-${check.id.toUpperCase()}` },
                    }))
                ),
              ],
            },
          ],
          results: sarifResults,
        },
      ],
    },
    null,
    2
  );
}

function toSarifResult(diag: Diagnostic, filePath: string) {
  return {
    ruleId: diag.ruleId,
    ...(diag.fingerprint ? { partialFingerprints: { codeVerifierFingerprint: diag.fingerprint } } : {}),
    level: SEVERITY_TO_SARIF_LEVEL[diag.severity] ?? 'note',
    message: { text: diag.message },
    properties: {
      severity: diag.severity,
      confidence: diag.confidence,
      category: diag.category,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: filePath },
          region: {
            startLine: diag.loc.start.line,
            startColumn: diag.loc.start.column + 1,
            endLine: diag.loc.end.line,
            endColumn: diag.loc.end.column + 1,
          },
        },
      },
    ],
  };
}

function cweToSeverityScore(cwe: string): string {
  const critical = ['CWE-79', 'CWE-798', 'CWE-89', 'CWE-95'];
  const high = ['CWE-312', 'CWE-476', 'CWE-922', 'CWE-835'];
  if (critical.includes(cwe)) return '9.0';
  if (high.includes(cwe)) return '7.0';
  return '5.0';
}
