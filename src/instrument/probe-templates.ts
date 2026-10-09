import { Diagnostic } from "../types/verifier";

/**
 * Generate probe code for a finding at a specified location.
 * Captures the variable value at the flagged location when possible.
 */
export function generateProbe(
  finding: Diagnostic,
  location: { line: number; column: number },
  variableName?: string,
): string {
  const loc = JSON.stringify(`L${location.line}`);
  const msg = JSON.stringify(finding.message);
  const valueArg = variableName ? `, ${variableName}` : "";

  switch (true) {
    case finding.ruleId.includes("NULL"):
      return `__cv_probe_null(${msg}, ${loc}${valueArg});`;

    case finding.ruleId.includes("TAINT"):
      return `__cv_probe_taint(${msg}, ${loc}${valueArg});`;

    case finding.ruleId.includes("COMP"):
      return `__cv_probe_props(${msg}, ${loc}${valueArg});`;

    case finding.ruleId.includes("RACE"):
      return `__cv_probe_async(${msg}, ${loc});`;

    case finding.ruleId.includes("ASYNC"):
      return `__cv_probe_promise(${msg}, ${loc});`;

    case finding.ruleId.includes("SERVICE"):
      return `__cv_probe_fetch(${msg}, ${loc});`;

    default:
      return `__cv_probe(${JSON.stringify(finding.ruleId)}, ${loc});`;
  }
}
