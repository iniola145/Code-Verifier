"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMFormatter = void 0;
class LLMFormatter {
    /**
     * Formats the verification result as concise, high-signal Markdown tailored for LLMs.
     */
    static formatForLLMPrompt(result) {
        if (result.status === 'PASSED') {
            return `### ✅ Code Verification: PASSED
- File: \`${result.filePath}\`
- Lines Analyzed: ${result.stats.totalLines}
- Rules Checked: ${result.stats.rulesChecked}
- Status: No security flaws, React hook violations, or abstract interpretation failures detected.`;
        }
        if (result.status === 'INCOMPLETE') {
            const incomplete = result.checks.filter((check) => check.status === 'INCOMPLETE' || check.status === 'SKIPPED');
            return [
                `### Code Verification: INCOMPLETE`,
                `- File: \`${result.filePath}\``,
                `- Analysis cannot establish that this file passed.`,
                ...incomplete.map((check) => `- ${check.name}: ${check.status}${check.message ? ` (${check.message})` : ''}`),
                `- Diagnostics produced before interruption: ${result.diagnostics.length}`,
            ].join('\n');
        }
        const sections = [
            `### ⚠️ Code Verification: FAILED (${result.diagnostics.length} issues found)`,
            `- File: \`${result.filePath}\``,
            `- Summary: Found ${result.stats.issuesCount.critical} Critical, ${result.stats.issuesCount.high} High, ${result.stats.issuesCount.medium} Medium issues.`,
            `\n#### Detailed Diagnostics for Remediation:`,
        ];
        result.diagnostics.forEach((diag, index) => {
            sections.push(this.formatDiagnostic(diag, index + 1));
        });
        sections.push(`\n#### Recommended Next Step:`);
        sections.push(`Please review each issue above, verify the root cause, and apply the recommended fix without introducing regressions.`);
        return sections.join('\n');
    }
    static formatDiagnostic(diag, num) {
        const lines = [
            `\n**Issue #${num}: [${diag.severity}] ${diag.ruleId}${diag.cweId ? ` (${diag.cweId})` : ''} - ${diag.message}**`,
            `- **Location**: Line ${diag.loc.start.line}, Col ${diag.loc.start.column}`,
            `- **Category**: ${diag.category}`,
            `- **Confidence**: ${diag.confidence ?? 'UNSPECIFIED'}`,
            `- **Explanation**: ${diag.explanation}`,
        ];
        if (diag.abstractInvariants && Object.keys(diag.abstractInvariants).length > 0) {
            const invariants = Object.entries(diag.abstractInvariants)
                .map(([k, v]) => `\`${k}\`: ${v}`)
                .join(', ');
            lines.push(`- **Abstract Invariants**: ${invariants}`);
        }
        lines.push(`- **Offending Code**:`);
        lines.push('```tsx');
        lines.push(diag.codeSnippet);
        lines.push('```');
        lines.push(`- **LLM Remediation Action**: ${diag.remediation.llmPromptHint}`);
        if (diag.remediation.suggestedFix) {
            lines.push(`- **Suggested Fix Pattern**: \`${diag.remediation.suggestedFix}\``);
        }
        return lines.join('\n');
    }
    /**
     * Returns a clean JSON string representing the result.
     */
    static formatJSON(result, pretty = true) {
        return JSON.stringify(result, null, pretty ? 2 : 0);
    }
}
exports.LLMFormatter = LLMFormatter;
