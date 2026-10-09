#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { CodeVerifier } from "./engine";
import { LLMFormatter } from "./formatter/llm-formatter";
import { formatSARIF } from "./formatter/sarif";
import { formatReport } from "./formatter/report";
import { loadConfig, isExcluded } from "./config";
import { VerificationResult } from "./types/verifier";
import { verifyProject, formatProjectChecks } from "./project-checks";
import { ProjectSummaryIndex } from "./abstract-interpreter/project-summaries";
import { loadBaseline, writeBaseline } from "./baseline";
import { DiagnosticSeverity } from "./types/verifier";
import { SemanticAnalysisIndex } from "./semantic-analysis";
import { ImportGraphIndex } from "./unused-files";
import { ProjectUiIndex } from "./project-ui-index";
import { verifyMobileConfigs } from "./mobile-config";
import { verifyDeploymentConfigs } from "./deployment-config";
import { verifyNativeConsistency } from "./native-consistency";
import { availableParallelism } from "os";
import * as os from "os";
import { execSync, spawnSync } from "child_process";
import {
  fileCacheKey,
  mapWithConcurrency,
  projectSignature,
  ScanCache,
} from "./scan-cache";
import { RULE_REGISTRY } from "./rules/registry";
import { generateTests } from "./test-gen/generator";
import { OutputMode, TestFramework } from "./test-gen/types";
import { parseTraceFile, parseJestOutput } from "./runtime/trace-parser";
import { analyzeRuntimeTraces } from "./runtime/runtime-engine";
import { TraceEvent, UnifiedAnalysisReport } from "./runtime/types";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".expo",
  "coverage",
]);

/** Expands CLI targets: files pass through, directories are walked recursively. */
export function expandTargets(
  targets: string[],
  excludes: string[] = [],
): string[] {
  const files: string[] = [];
  const walk = (p: string, root: string) => {
    if (!fs.existsSync(p)) {
      console.error(`Warning: path does not exist, skipping: ${p}`);
      return;
    }
    const stat = fs.statSync(p);
    if (stat.isFile()) {
      // Directly named files must pass the same source filter as walked
      // files; config formats (manifests, plists, workflows, Dockerfiles)
      // are discovered and verified by their dedicated scanners instead.
      if (
        SOURCE_EXTENSIONS.has(path.extname(p)) &&
        !path.basename(p).endsWith(".d.ts") &&
        !isExcluded(p, excludes)
      )
        files.push(p);
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        const child = path.join(p, entry.name);
        const relFromRoot = path.relative(root, child);
        if (
          entry.isFile() &&
          SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
          !entry.name.endsWith(".d.ts") &&
          !isExcluded(child, excludes) &&
          !isExcluded(relFromRoot, excludes)
        ) {
          files.push(child);
        } else if (
          entry.isDirectory() &&
          !isExcluded(relFromRoot, excludes) &&
          !isExcluded(child, excludes)
        ) {
          walk(child, root);
        }
      }
    }
  };
  targets.forEach((t) => walk(t, t));
  return files;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list-rules")) {
    const rules = [...RULE_REGISTRY.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    if (args.includes("--json")) console.log(JSON.stringify(rules, null, 2));
    else
      for (const rule of rules) {
        console.log(
          `${rule.id.padEnd(12)} ${rule.defaultSeverity.padEnd(8)} ${rule.name}`,
        );
      }
    process.exit(0);
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Code Verifier - SAST & Abstract Interpretation for React, React Native & Expo

Usage:
  npx code-verifier <file-or-dir> [more targets...] [options]
  cat file.tsx | npx code-verifier --stdin [options]

Targets can be files or directories (walked recursively, skipping
node_modules/dist/build and .d.ts).

Options:
  --format=llm       Output optimized Markdown prompt for LLM consumption (default)
  --format=json      Output structured JSON for programmatic agents
  --format=sarif     Output SARIF 2.1.0 for GitHub code scanning / CI
  --format=summary   Output brief one-line summaries
  --format=report    Whole-project health report (by-rule and by-file)
  --no-ai            Disable abstract interpretation (pattern SAST only)
  --project-checks    Run typecheck, lint, build, tests, audit, and Expo Doctor
  --disable=RULES    Comma-separated rule ids or prefixes (e.g. --disable=SEC,WEB-001)
  --fail-on=SEVERITY Fail when findings reach this severity (default: MEDIUM)
  --baseline=FILE    Suppress findings recorded in a baseline file
  --write-baseline=FILE  Write current findings as a baseline
  --workers=N        Bound concurrent file scheduling (default: available CPUs, max 8)
  --cache[=FILE]     Reuse unchanged results from a persistent cache
  --changed          Analyze only Git changed/untracked source files
  --generate-tests[=TARGET]  Generate runnable test suites from static analysis facts
  --output=DIR               Output directory for generated tests (default: .verifier/tests)
  --framework=NAME           Target test framework: jest | vitest | detox (auto-detected)
  --rule=RULE_ID             Filter generation to a specific rule ID (e.g. AI-NULL-001)
  --in-place                 Write generated test files alongside target files
  --with-jest                Run Jest and capture runtime traces
  --with-vitest              Run Vitest and capture runtime traces
  --jest-config=FILE         Specify custom Jest configuration file
  --runtime-traces=FILE      Correlate static findings with existing JSONL/JUnit trace file
  --run-tests                Run tests using detected runner
  --test-command=CMD         Custom command to execute tests
  --test-format=FORMAT       Format of test output: json | junit | verbose
  --no-correlate             Disable static-to-runtime correlation
  --list-rules       Print the complete rule catalog (add --json for metadata)
  --help, -h         Show this help message

Suppression:
  // code-verifier-disable-next-line   (hides the finding on the next line)
  // code-verifier-disable-file        (hides all findings in this file)

Examples:
  npx code-verifier src/screens/HomeScreen.tsx
  npx code-verifier src/ --format=sarif > results.sarif
  npx code-verifier src/App.tsx src/lib --format=json
`);
    process.exit(0);
  }

  const formatArg = args.find((a) => a.startsWith("--format="));
  const format = formatArg ? formatArg.split("=")[1] : "llm";
  const disableAI = args.includes("--no-ai");
  const runProjectChecks = args.includes("--project-checks");
  const isStdin = args.includes("--stdin");
  const disableFlag = args.find((a) => a.startsWith("--disable="));
  const cliDisable = disableFlag
    ? disableFlag
        .split("=")[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const failOnFlag = args.find((a) => a.startsWith("--fail-on="));
  const baselineFlag = args.find((a) => a.startsWith("--baseline="));
  const writeBaselineFlag = args.find((a) => a.startsWith("--write-baseline="));
  const workersFlag = args.find((a) => a.startsWith("--workers="));
  const cacheFlag = args.find(
    (a) => a === "--cache" || a.startsWith("--cache="),
  );
  const changedOnly = args.includes("--changed");
  const workers = workersFlag
    ? Number(workersFlag.split("=")[1])
    : Math.min(availableParallelism(), 8);
  if (!Number.isInteger(workers) || workers < 1 || workers > 64) {
    console.error(
      "Configuration error: --workers must be an integer from 1 to 64.",
    );
    process.exit(2);
  }

  function getFlag(cliArgs: string[], name: string): string | undefined {
    for (let i = 0; i < cliArgs.length; i++) {
      const a = cliArgs[i];
      if (a === name) {
        if (i + 1 < cliArgs.length && !cliArgs[i + 1].startsWith("--")) {
          return cliArgs[i + 1];
        }
        return "";
      }
      if (a.startsWith(`${name}=`)) {
        return a.slice(name.length + 1);
      }
    }
    return undefined;
  }

  function getPositionalTargets(cliArgs: string[]): string[] {
    const flagsWithValue = new Set([
      "--format",
      "--disable",
      "--fail-on",
      "--baseline",
      "--write-baseline",
      "--workers",
      "--output",
      "--framework",
      "--rule",
      "--jest-config",
      "--vitest-config",
      "--runtime-traces",
      "--test-command",
    ]);

    const posTargets: string[] = [];
    for (let i = 0; i < cliArgs.length; i++) {
      const a = cliArgs[i];
      if (a.startsWith("--")) {
        const flagName = a.split("=")[0];
        if (flagsWithValue.has(flagName) && !a.includes("=")) {
          i++;
        }
      } else {
        posTargets.push(a);
      }
    }
    return posTargets;
  }

  // Config is discovered upward from the first target (or cwd for --stdin).
  const targets = getPositionalTargets(args);
  const configStart = isStdin
    ? process.cwd()
    : targets[0] &&
        fs.existsSync(targets[0]) &&
        fs.statSync(targets[0]).isDirectory()
      ? targets[0]
      : targets[0]
        ? path.dirname(targets[0])
        : process.cwd();
  const { config, configPath, errors: configErrors } = loadConfig(configStart);
  if (configPath) console.error(`Config: ${configPath}`);
  if (configErrors.length > 0) {
    for (const error of configErrors)
      console.error(`Configuration error: ${error}`);
    process.exit(2);
  }

  const validSeverities = new Set<DiagnosticSeverity>([
    "CRITICAL",
    "HIGH",
    "MEDIUM",
    "LOW",
    "INFO",
  ]);
  const failOnValue = failOnFlag?.split("=")[1] ?? config.failOn;
  if (!validSeverities.has(failOnValue as DiagnosticSeverity)) {
    console.error(
      `Configuration error: invalid --fail-on severity "${failOnValue}".`,
    );
    process.exit(2);
  }
  const failOn = failOnValue as DiagnosticSeverity;
  const configDir = configPath
    ? path.dirname(configPath)
    : path.resolve(configStart);
  const projectRoot = configDir;
  const baselineValue = baselineFlag?.split("=")[1] ?? config.baseline;
  const baselinePath = baselineValue
    ? path.resolve(configDir, baselineValue)
    : undefined;
  const outputBaselinePath = writeBaselineFlag
    ? path.resolve(configDir, writeBaselineFlag.split("=")[1])
    : undefined;
  let baselineFingerprints: ReadonlySet<string> = new Set();
  if (baselinePath && !outputBaselinePath) {
    try {
      baselineFingerprints = loadBaseline(baselinePath);
      console.error(
        `Baseline: ${baselinePath} (${baselineFingerprints.size} fingerprints)`,
      );
    } catch (error: any) {
      console.error(`Baseline error: ${error.message}`);
      process.exit(2);
    }
  }

  const isGenerateTests =
    args.includes("--generate-tests") ||
    args.some((a) => a.startsWith("--generate-tests="));

  if (isGenerateTests) {
    const genTargetFlag = getFlag(args, "--generate-tests");
    const genTargets =
      genTargetFlag && genTargetFlag !== ""
        ? [genTargetFlag]
        : targets;

    if (genTargets.length === 0) {
      console.error(
        "Error: No target file or directory specified for --generate-tests.",
      );
      process.exit(1);
    }

    const outputDir = getFlag(args, "--output") || ".verifier/tests";
    const framework = getFlag(args, "--framework") as TestFramework | undefined;
    const ruleFilterVal = getFlag(args, "--rule");
    const ruleFilter = ruleFilterVal ? [ruleFilterVal] : undefined;
    const mode: OutputMode = args.includes("--in-place")
      ? "in-place"
      : "directory";

    const files = expandTargets(genTargets, config.exclude);
    const results = await generateTests(files, {
      framework,
      outputDir,
      mode,
      ruleFilter,
      includeSetup: true,
      projectRoot,
    });

    for (const result of results) {
      if (mode === "in-place") {
        fs.writeFileSync(result.filePath, result.content, "utf-8");
        console.log(`Wrote ${result.filePath}`);
      } else {
        const outputPath = path.join(
          outputDir,
          path.basename(result.filePath),
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, result.content, "utf-8");
        console.log(`Wrote ${outputPath}`);
      }
    }

    console.log(`Generated ${results.length} test file(s)`);
    process.exit(0);
  }

  // =========================================================================
  // Phase 2B: Test Runner Integration & Runtime Correlation
  // =========================================================================
  const withJest =
    args.includes("--with-jest") ||
    args.some((a) => a.startsWith("--with-jest"));
  const withVitest =
    args.includes("--with-vitest") ||
    args.some((a) => a.startsWith("--with-vitest"));
  const runtimeTracesFlag = getFlag(args, "--runtime-traces");
  const runTests =
    args.includes("--run-tests") ||
    args.some((a) => a.startsWith("--run-tests"));
  const testCommand = getFlag(args, "--test-command");
  const jestConfig = getFlag(args, "--jest-config");
  const vitestConfig = getFlag(args, "--vitest-config");
  const isRuntimeRun =
    withJest ||
    withVitest ||
    Boolean(runtimeTracesFlag) ||
    runTests ||
    Boolean(testCommand);

  if (isRuntimeRun) {
    let traceEvents: TraceEvent[] = [];

    if (runtimeTracesFlag) {
      traceEvents = parseTraceFile(path.resolve(runtimeTracesFlag));
    } else {
      const tmpTraceFile = path.join(
        os.tmpdir(),
        `cv-trace-${Date.now()}-${Math.random().toString(36).substring(2)}.jsonl`,
      );

      let cmd = testCommand;
      if (!cmd) {
        if (withJest) {
          const reporterPath = path.resolve(
            __dirname,
            "adapters/jest-reporter.js",
          );
          const configArg = jestConfig ? `--config "${jestConfig}"` : "";
          cmd = `npx jest ${configArg} --reporters=default --reporters="${reporterPath}"`;
        } else if (withVitest) {
          const configArg = vitestConfig ? `--config "${vitestConfig}"` : "";
          cmd = `npx vitest run ${configArg}`;
        } else {
          cmd = "npm test";
        }
      }

      try {
        execSync(cmd, {
          cwd: projectRoot,
          stdio: "pipe",
          env: { ...process.env, CODE_VERIFIER_TRACE_FILE: tmpTraceFile },
          encoding: "utf-8",
        });
      } catch (execErr: any) {
        if (fs.existsSync(tmpTraceFile)) {
          traceEvents = parseTraceFile(tmpTraceFile);
        } else {
          const stdout = execErr.stdout ? String(execErr.stdout) : "";
          traceEvents = parseJestOutput(stdout);
        }
      }

      if (traceEvents.length === 0 && fs.existsSync(tmpTraceFile)) {
        traceEvents = parseTraceFile(tmpTraceFile);
      }
      try {
        if (fs.existsSync(tmpTraceFile)) fs.unlinkSync(tmpTraceFile);
      } catch {}
    }

    // Run static analysis on targets
    const staticResults: VerificationResult[] = [];
    const allFiles = isStdin ? [] : expandTargets(targets, config.exclude);

    const sharedUiIndex =
      allFiles.length > 0 ? ProjectUiIndex.fromFiles(allFiles) : undefined;
    const sharedSummaryIndex =
      allFiles.length > 0
        ? ProjectSummaryIndex.fromFiles(allFiles)
        : undefined;

    const runtimeVerifier = new CodeVerifier({
      enableAbstractInterpretation: !disableAI,
      disabledRules: [...config.disable, ...cliDisable],
      severityOverrides: config.severities,
      projectSummaryIndex: sharedSummaryIndex,
      projectUiIndex: sharedUiIndex,
      baselineFingerprints,
      failOn,
      projectRoot,
    });

    if (isStdin) {
      const code = fs.readFileSync(0, "utf-8");
      staticResults.push(await runtimeVerifier.verifyCode(code, "stdin.tsx"));
    } else {
      for (const f of allFiles) {
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
        const code = fs.readFileSync(f, "utf-8");
        staticResults.push(await runtimeVerifier.verifyCode(code, f));
      }
    }

    const allStaticDiagnostics = staticResults.flatMap((r) => r.diagnostics);
    const runtimeFindings = analyzeRuntimeTraces(
      traceEvents,
      allStaticDiagnostics,
    );

    if (format === "json") {
      const report: UnifiedAnalysisReport = {
        staticFindings: allStaticDiagnostics,
        runtimeFindings,
        summary: {
          totalStatic: allStaticDiagnostics.length,
          totalRuntime: runtimeFindings.length,
          confirmedCount: runtimeFindings.filter((f) =>
            f.ruleId.startsWith("RT-CONFIRM"),
          ).length,
          newRuntimeCount: runtimeFindings.filter((f) =>
            f.ruleId.startsWith("RT-NEW"),
          ).length,
        },
      };
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        LLMFormatter.formatUnifiedReport(staticResults, runtimeFindings),
      );
    }

    process.exit(0);
  }

  let verifier = new CodeVerifier({
    enableAbstractInterpretation: !disableAI,
    disabledRules: [...config.disable, ...cliDisable],
    severityOverrides: config.severities,
    baselineFingerprints,
    failOn,
    projectRoot,
  });

  try {
    let results: VerificationResult[];
    const projectResults =
      runProjectChecks && !isStdin
        ? [
            ...new Set(
              targets.map((target) => {
                const resolved = path.resolve(target);
                return fs.statSync(resolved).isDirectory()
                  ? resolved
                  : path.dirname(resolved);
              }),
            ),
          ].map((root) =>
            verifyProject(root, {
              build: true,
              tests: true,
              audit: true,
              expoDoctor: true,
            }),
          )
        : [];

    if (isStdin) {
      const code = fs.readFileSync(0, "utf-8");
      results = [await verifier.verifyCode(code, "stdin.tsx")];
    } else {
      if (targets.length === 0) {
        console.error("Error: No target file or directory specified.");
        process.exit(1);
      }
      const allFiles = expandTargets(targets, config.exclude);
      const files = changedOnly
        ? filterChangedFiles(allFiles, targets)
        : allFiles;
      // No early exit when files is empty: mobile/deployment config scanners
      // below may still produce results for config-only targets.
      verifier = new CodeVerifier({
        enableAbstractInterpretation: !disableAI,
        disabledRules: [...config.disable, ...cliDisable],
        severityOverrides: config.severities,
        projectSummaryIndex: ProjectSummaryIndex.fromFiles(allFiles),
        semanticAnalysisIndex: SemanticAnalysisIndex.fromFiles(allFiles),
        importGraphIndex: ImportGraphIndex.fromFiles(allFiles, projectRoot),
        projectUiIndex: ProjectUiIndex.fromFiles(allFiles),
        baselineFingerprints,
        failOn,
        projectRoot,
      });
      const signature = projectSignature(allFiles);
      const cachePath = cacheFlag
        ? path.resolve(
            process.cwd(),
            cacheFlag.includes("=")
              ? cacheFlag.split("=")[1]
              : ".codeverifier-cache.json",
          )
        : null;
      const cache = cachePath ? new ScanCache(cachePath) : null;
      const optionsIdentity = JSON.stringify({
        disableAI,
        disabled: [...config.disable, ...cliDisable].sort(),
        severities: config.severities,
        failOn,
        projectRoot,
        baseline: [...baselineFingerprints].sort(),
      });
      let cacheHits = 0;
      results = (
        await mapWithConcurrency(files, workers, async (file) => {
          const key = fileCacheKey(file, signature, optionsIdentity);
          const cached = cache?.get(key);
          if (cached) {
            cacheHits++;
            return cached;
          }
          try {
            const result = await verifier.verifyFile(file);
            cache?.set(key, result);
            return result;
          } catch (err: any) {
            console.error(`Skipping ${file}: ${err.message}`);
            return null;
          }
        })
      ).filter((result): result is VerificationResult => result !== null);
      if (cache) {
        cache.save();
        console.error(
          `Cache: ${cacheHits}/${files.length} file result(s) reused from ${cachePath}`,
        );
      }
      results.push(
        ...verifyMobileConfigs(targets, {
          projectRoot,
          baselineFingerprints,
          failOn,
          disabledRules: [...config.disable, ...cliDisable],
          severityOverrides: config.severities,
        }),
      );
      results.push(
        ...verifyDeploymentConfigs(targets, {
          projectRoot,
          baselineFingerprints,
          failOn,
          disabledRules: [...config.disable, ...cliDisable],
          severityOverrides: config.severities,
        }),
      );
      results.push(
        ...verifyNativeConsistency(targets, {
          projectRoot,
          baselineFingerprints,
          failOn,
          disabledRules: [...config.disable, ...cliDisable],
          severityOverrides: config.severities,
        }),
      );
      if (results.length === 0) {
        console.error(
          "Error: No analyzable files or configuration files found in the given targets.",
        );
        process.exit(1);
      }
    }

    if (outputBaselinePath) {
      const baselineDiagnostics = results.flatMap(
        (result) => result.diagnostics,
      );
      writeBaseline(outputBaselinePath, baselineDiagnostics);
      const uniqueFingerprints = new Set(
        baselineDiagnostics.map((item) => item.fingerprint).filter(Boolean),
      ).size;
      console.error(
        `Baseline written: ${outputBaselinePath} (${baselineDiagnostics.length} findings, ${uniqueFingerprints} unique fingerprints)`,
      );
    }

    if (format === "json") {
      const payload = isStdin || results.length === 1 ? results[0] : results;
      console.log(
        LLMFormatter.formatJSON(
          (projectResults.length > 0
            ? { files: payload, projects: projectResults }
            : payload) as any,
        ),
      );
    } else if (format === "sarif") {
      console.log(formatSARIF(results, projectResults));
    } else if (format === "summary") {
      for (const r of results)
        console.log(`${r.status.padEnd(10)} ${r.filePath} — ${r.summary}`);
      for (const project of projectResults)
        console.log(formatProjectChecks(project));
    } else if (format === "report") {
      console.log(formatReport(results));
      for (const project of projectResults)
        console.log(`\n${formatProjectChecks(project)}`);
    } else {
      const failed = results.filter((r) => r.status !== "PASSED");
      const passed = results.filter((r) => r.status === "PASSED");
      if (passed.length > 0) {
        console.log(
          `✅ Passed (${passed.length}): ${passed.map((r) => path.basename(r.filePath)).join(", ")}\n`,
        );
      }
      // Below-gate (advisory) findings on passing files stay visible here: the
      // severity gate keeps them non-blocking, not invisible.
      for (const advisory of passed.filter((r) => r.diagnostics.length > 0)) {
        const lines = advisory.diagnostics
          .map(
            (d) =>
              `  [${d.severity}] ${d.ruleId} (L${d.loc.start.line}): ${d.message}`,
          )
          .join("\n");
        console.log(
          `⚠️  Advisory — ${path.basename(advisory.filePath)} (does not fail the run at the current gate):\n${lines}\n`,
        );
      }
      for (const r of failed) {
        console.log(LLMFormatter.formatForLLMPrompt(r));
        console.log("\n" + "-".repeat(60) + "\n");
      }
      for (const project of projectResults)
        console.log(`\n${formatProjectChecks(project)}`);
    }

    const anyFailed =
      results.some((r) => r.status === "FAILED") ||
      projectResults.some((r) => r.status === "FAILED");
    const anyIncomplete =
      results.some((r) => r.status === "INCOMPLETE") ||
      projectResults.some((r) => r.status === "INCOMPLETE");
    process.exit(
      outputBaselinePath
        ? anyIncomplete
          ? 2
          : 0
        : anyFailed
          ? 1
          : anyIncomplete
            ? 2
            : 0,
    );
  } catch (error: any) {
    console.error(`Verification error: ${error.message}`);
    process.exit(2);
  }
}

main();

function filterChangedFiles(files: string[], targets: string[]): string[] {
  const changed = new Set<string>();
  const roots = [
    ...new Set(
      targets.map((target) => {
        const resolved = path.resolve(target);
        return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
          ? resolved
          : path.dirname(resolved);
      }),
    ),
  ];
  for (const root of roots) {
    const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    if (top.status !== 0) continue;
    const repo = top.stdout.trim();
    for (const args of [
      ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"],
      ["ls-files", "--others", "--exclude-standard"],
    ]) {
      const output = spawnSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
      });
      if (output.status === 0)
        output.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .forEach((file) => changed.add(path.resolve(repo, file)));
    }
  }
  return files.filter((file) => changed.has(path.resolve(file)));
}
