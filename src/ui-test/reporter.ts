import { UITestSession, UIBug } from "./session";

/**
 * Generate a formatted markdown bug report from a UI test session.
 */
export function generateBugReport(session: UITestSession): string {
  const durationMs =
    session.completedAt && session.startedAt
      ? Math.max(0, new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime())
      : 0;

  const durationStr =
    durationMs >= 1000
      ? `${(durationMs / 1000).toFixed(1)}s`
      : `${durationMs}ms`;

  const criticalCount = session.bugs.filter((b) => b.severity === "critical").length;
  const highCount = session.bugs.filter((b) => b.severity === "high").length;
  const mediumCount = session.bugs.filter((b) => b.severity === "medium").length;
  const lowCount = session.bugs.filter((b) => b.severity === "low").length;

  function capitalize(str: string): string {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function formatCategory(cat: string): string {
    if (cat.toLowerCase() === "ux") return "UX";
    return capitalize(cat);
  }

  const lines: string[] = [
    "# UI Test Report",
    "",
    `**Session:** ${session.id}`,
    `**Target:** ${session.target}`,
    `**Duration:** ${durationStr}`,
    `**Steps:** ${session.steps.length}`,
    `**Bugs Found:** ${session.bugs.length}`,
    "",
    "## Bugs",
    "",
  ];

  if (session.bugs.length === 0) {
    lines.push("No UI bugs detected across tested flows.", "");
  } else {
    session.bugs.forEach((bug: UIBug, index: number) => {
      const sevUpper = bug.severity.toUpperCase();
      const sevCapital = capitalize(bug.severity);
      const catTitle = formatCategory(bug.category);

      lines.push(`### ${index + 1}. [${sevUpper}] ${catTitle}: ${bug.description}`);
      if (bug.location) {
        lines.push(`- **Location:** ${bug.location}`);
      }
      lines.push(`- **Severity:** ${sevCapital}`);
      lines.push(`- **Category:** ${catTitle}`);
      lines.push(`- **Description:** ${bug.description}`);
      lines.push("- **Reproduction Steps:**");
      if (bug.reproductionSteps && bug.reproductionSteps.length > 0) {
        bug.reproductionSteps.forEach((step, sIdx) => {
          lines.push(`  ${sIdx + 1}. ${step}`);
        });
      } else {
        lines.push("  1. Navigate to target screen");
        lines.push(`  2. Observe: ${bug.description}`);
      }
      lines.push(`- **Screenshot:** ${bug.screenshot ? "[attached]" : "[not captured]"}`);
      lines.push("");
    });
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Critical: ${criticalCount}`);
  lines.push(`- High: ${highCount}`);
  lines.push(`- Medium: ${mediumCount}`);
  lines.push(`- Low: ${lowCount}`);

  return lines.join("\n");
}
