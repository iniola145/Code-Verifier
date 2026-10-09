import { VerificationResult, Diagnostic } from "../types/verifier";
import { RuntimeFinding } from "../runtime/types";

export class LLMFormatter {
  /**
   * Formats the verification result as concise, high-signal Markdown tailored for LLMs.
   */
  static formatForLLMPrompt(result: VerificationResult): string {
    if (result.status === "PASSED") {
      return `### ✅ Code Verification: PASSED
- File: \`${result.filePath}\`
- Lines Analyzed: ${result.stats.totalLines}
- Rules Checked: ${result.stats.rulesChecked}
- Status: No security flaws, React hook violations, or abstract interpretation failures detected.`;
    }

    if (result.status === "INCOMPLETE") {
      const incomplete = result.checks.filter(
        (check) => check.status === "INCOMPLETE" || check.status === "SKIPPED",
      );
      return [
        `### Code Verification: INCOMPLETE`,
        `- File: \`${result.filePath}\``,
        `- Analysis cannot establish that this file passed.`,
        ...incomplete.map(
          (check) =>
            `- ${check.name}: ${check.status}${check.message ? ` (${check.message})` : ""}`,
        ),
        `- Diagnostics produced before interruption: ${result.diagnostics.length}`,
      ].join("\n");
    }

    const sections: string[] = [
      `### ⚠️ Code Verification: FAILED (${result.diagnostics.length} issues found)`,
      `- File: \`${result.filePath}\``,
      `- Summary: Found ${result.stats.issuesCount.critical} Critical, ${result.stats.issuesCount.high} High, ${result.stats.issuesCount.medium} Medium issues.`,
      `\n#### Detailed Diagnostics for Remediation:`,
    ];

    result.diagnostics.forEach((diag, index) => {
      sections.push(this.formatDiagnostic(diag, index + 1));
    });

    sections.push(`\n#### Recommended Next Step:`);
    sections.push(
      `Please review each issue above, verify the root cause, and apply the recommended fix without introducing regressions.`,
    );

    return sections.join("\n");
  }

  private static formatDiagnostic(diag: Diagnostic, num: number): string {
    const lines: string[] = [
      `\n**Issue #${num}: [${diag.severity}] ${diag.ruleId}${diag.cweId ? ` (${diag.cweId})` : ""} - ${diag.message}**`,
      `- **Location**: Line ${diag.loc.start.line}, Col ${diag.loc.start.column}`,
      `- **Category**: ${diag.category}`,
      `- **Confidence**: ${diag.confidence ?? "UNSPECIFIED"}`,
      `- **Explanation**: ${diag.explanation}`,
    ];

    if (
      diag.abstractInvariants &&
      Object.keys(diag.abstractInvariants).length > 0
    ) {
      const invariants = Object.entries(diag.abstractInvariants)
        .map(([k, v]) => `\`${k}\`: ${v}`)
        .join(", ");
      lines.push(`- **Abstract Invariants**: ${invariants}`);
    }

    lines.push(`- **Offending Code**:`);
    lines.push("```tsx");
    lines.push(diag.codeSnippet);
    lines.push("```");

    lines.push(
      `- **LLM Remediation Action**: ${diag.remediation.llmPromptHint}`,
    );
    if (diag.remediation.suggestedFix) {
      lines.push(
        `- **Suggested Fix Pattern**: \`${diag.remediation.suggestedFix}\``,
      );
    }

    return lines.join("\n");
  }

  /**
   * Returns a clean JSON string representing the result.
   */
  static formatJSON(result: VerificationResult, pretty = true): string {
    return JSON.stringify(result, null, pretty ? 2 : 0);
  }

  /**
   * Format runtime findings and unified static+runtime report for LLM / CLI.
   */
  static formatRuntimeFindings(findings: RuntimeFinding[]): string {
    return formatRuntimeFindings(findings);
  }

  static formatUnifiedReport(
    staticResults: VerificationResult[],
    runtimeFindings: RuntimeFinding[],
  ): string {
    const totalStatic = staticResults.reduce(
      (sum, r) => sum + r.diagnostics.length,
      0,
    );
    const confirmedCount = runtimeFindings.filter((f) =>
      f.ruleId.startsWith("RT-CONFIRM"),
    ).length;
    const newCount = runtimeFindings.filter((f) =>
      f.ruleId.startsWith("RT-NEW"),
    ).length;

    const sections: string[] = [
      `## 🔍 Code Verifier Unified Report (Static + Runtime)`,
      `- Static Diagnostics: ${totalStatic}`,
      `- Confirmed by Tests: ${confirmedCount}`,
      `- New Runtime Bugs Discovered: ${newCount}`,
    ];

    if (runtimeFindings.length > 0) {
      sections.push(`\n### ⚡ Runtime Verified Findings:\n`);
      sections.push(formatRuntimeFindings(runtimeFindings));
    }

    if (staticResults.length > 0) {
      sections.push(`\n### 📋 Static Analysis Results:\n`);
      for (const res of staticResults) {
        sections.push(LLMFormatter.formatForLLMPrompt(res));
      }
    }

    return sections.join("\n");
  }
}

/**
 * Formats runtime findings into Markdown.
 */
export function formatRuntimeFindings(findings: RuntimeFinding[]): string {
  if (findings.length === 0) {
    return "No runtime issues detected in test execution.";
  }

  return findings
    .map((f) => {
      const traceLines = f.trace
        .map((e) => `  - ${e.type}: ${JSON.stringify(e)}`)
        .join("\n");

      return `### [${f.severity}] ${f.ruleId}: ${f.message}
- **File**: \`${f.filePath}:${f.loc.start.line}\`
- **Confidence**: **${f.confidence}**
- **Confirmed By**: \`${f.confirmedBy}\`
${f.staticFinding ? `- **Correlated Static Rule**: \`${f.staticFinding.ruleId}\`` : ""}

**Trace Evidence**:
${traceLines}`;
    })
    .join("\n\n");
}

