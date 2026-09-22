#!/usr/bin/env node
import * as path from "path";
import { spawnSync } from "child_process";

const targets = (process.env.INPUT_TARGETS || ".")
  .split(/[\n,]/)
  .map((target) => target.trim())
  .filter(Boolean);
const format = process.env.INPUT_FORMAT || "sarif";
const failOn = process.env.INPUT_FAIL_ON || "MEDIUM";
const extra = (process.env.INPUT_ARGUMENTS || "").split(/\s+/).filter(Boolean);
const result = spawnSync(
  process.execPath,
  [
    path.join(__dirname, "cli.js"),
    ...targets,
    `--format=${format}`,
    `--fail-on=${failOn}`,
    ...extra,
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(
    `Code Verifier action failed to start: ${result.error.message}`,
  );
  process.exit(2);
}
process.exit(result.status ?? 2);
