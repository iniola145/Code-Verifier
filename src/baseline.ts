import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Diagnostic } from "./types/verifier";

export interface BaselineFile {
  version: 1;
  fingerprints: string[];
}

export function diagnosticFingerprint(
  diagnostic: Diagnostic,
  lines: string[],
  projectRoot?: string,
): string {
  const relativePath = projectRoot
    ? path.relative(
        path.resolve(projectRoot),
        path.resolve(diagnostic.filePath),
      )
    : path.basename(diagnostic.filePath);
  const source = lines
    .slice(
      Math.max(0, diagnostic.loc.start.line - 1),
      Math.max(diagnostic.loc.start.line, diagnostic.loc.end.line),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const identity = [
    diagnostic.ruleId,
    relativePath.split(path.sep).join("/"),
    source,
    diagnostic.message,
  ].join("\0");
  return createHash("sha256").update(identity).digest("hex");
}

export function loadBaseline(filePath: string): Set<string> {
  const raw = JSON.parse(
    fs.readFileSync(filePath, "utf8"),
  ) as Partial<BaselineFile>;
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.fingerprints) ||
    raw.fingerprints.some(
      (value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value),
    )
  ) {
    throw new Error(`Invalid baseline format: ${filePath}`);
  }
  return new Set(raw.fingerprints);
}

export function writeBaseline(
  filePath: string,
  diagnostics: Diagnostic[],
): void {
  const baseline: BaselineFile = {
    version: 1,
    fingerprints: [
      ...new Set(
        diagnostics
          .map((item) => item.fingerprint)
          .filter((value): value is string => !!value),
      ),
    ].sort(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}
