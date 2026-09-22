#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandTargets = expandTargets;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const engine_1 = require("./engine");
const llm_formatter_1 = require("./formatter/llm-formatter");
const sarif_1 = require("./formatter/sarif");
const report_1 = require("./formatter/report");
const config_1 = require("./config");
const project_checks_1 = require("./project-checks");
const project_summaries_1 = require("./abstract-interpreter/project-summaries");
const baseline_1 = require("./baseline");
const semantic_analysis_1 = require("./semantic-analysis");
const mobile_config_1 = require("./mobile-config");
const deployment_config_1 = require("./deployment-config");
const native_consistency_1 = require("./native-consistency");
const os_1 = require("os");
const child_process_1 = require("child_process");
const scan_cache_1 = require("./scan-cache");
const registry_1 = require("./rules/registry");
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.expo', 'coverage']);
/** Expands CLI targets: files pass through, directories are walked recursively. */
function expandTargets(targets, excludes = []) {
    const files = [];
    const walk = (p, root) => {
        if (!fs.existsSync(p)) {
            console.error(`Warning: path does not exist, skipping: ${p}`);
            return;
        }
        const stat = fs.statSync(p);
        if (stat.isFile()) {
            // Directly named files must pass the same source filter as walked
            // files; config formats (manifests, plists, workflows, Dockerfiles)
            // are discovered and verified by their dedicated scanners instead.
            if (SOURCE_EXTENSIONS.has(path.extname(p)) &&
                !path.basename(p).endsWith('.d.ts') &&
                !(0, config_1.isExcluded)(p, excludes))
                files.push(p);
        }
        else if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
                if (entry.isDirectory() && SKIP_DIRS.has(entry.name))
                    continue;
                const child = path.join(p, entry.name);
                const relFromRoot = path.relative(root, child);
                if (entry.isFile() &&
                    SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
                    !entry.name.endsWith('.d.ts') &&
                    !(0, config_1.isExcluded)(child, excludes) &&
                    !(0, config_1.isExcluded)(relFromRoot, excludes)) {
                    files.push(child);
                }
                else if (entry.isDirectory() && !(0, config_1.isExcluded)(relFromRoot, excludes) && !(0, config_1.isExcluded)(child, excludes)) {
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
    if (args.includes('--list-rules')) {
        const rules = [...registry_1.RULE_REGISTRY.values()].sort((a, b) => a.id.localeCompare(b.id));
        if (args.includes('--json'))
            console.log(JSON.stringify(rules, null, 2));
        else
            for (const rule of rules) {
                console.log(`${rule.id.padEnd(12)} ${rule.defaultSeverity.padEnd(8)} ${rule.name}`);
            }
        process.exit(0);
    }
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
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
    const formatArg = args.find((a) => a.startsWith('--format='));
    const format = formatArg ? formatArg.split('=')[1] : 'llm';
    const disableAI = args.includes('--no-ai');
    const runProjectChecks = args.includes('--project-checks');
    const isStdin = args.includes('--stdin');
    const disableFlag = args.find((a) => a.startsWith('--disable='));
    const cliDisable = disableFlag ? disableFlag.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const failOnFlag = args.find((a) => a.startsWith('--fail-on='));
    const baselineFlag = args.find((a) => a.startsWith('--baseline='));
    const writeBaselineFlag = args.find((a) => a.startsWith('--write-baseline='));
    const workersFlag = args.find((a) => a.startsWith('--workers='));
    const cacheFlag = args.find((a) => a === '--cache' || a.startsWith('--cache='));
    const changedOnly = args.includes('--changed');
    const workers = workersFlag ? Number(workersFlag.split('=')[1]) : Math.min((0, os_1.availableParallelism)(), 8);
    if (!Number.isInteger(workers) || workers < 1 || workers > 64) {
        console.error('Configuration error: --workers must be an integer from 1 to 64.');
        process.exit(2);
    }
    // Config is discovered upward from the first target (or cwd for --stdin).
    const targets = args.filter((a) => !a.startsWith('--'));
    const configStart = isStdin
        ? process.cwd()
        : targets[0] && fs.existsSync(targets[0]) && fs.statSync(targets[0]).isDirectory()
            ? targets[0]
            : targets[0]
                ? path.dirname(targets[0])
                : process.cwd();
    const { config, configPath, errors: configErrors } = (0, config_1.loadConfig)(configStart);
    if (configPath)
        console.error(`Config: ${configPath}`);
    if (configErrors.length > 0) {
        for (const error of configErrors)
            console.error(`Configuration error: ${error}`);
        process.exit(2);
    }
    const validSeverities = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
    const failOnValue = failOnFlag?.split('=')[1] ?? config.failOn;
    if (!validSeverities.has(failOnValue)) {
        console.error(`Configuration error: invalid --fail-on severity "${failOnValue}".`);
        process.exit(2);
    }
    const failOn = failOnValue;
    const configDir = configPath ? path.dirname(configPath) : path.resolve(configStart);
    const projectRoot = configDir;
    const baselineValue = baselineFlag?.split('=')[1] ?? config.baseline;
    const baselinePath = baselineValue ? path.resolve(configDir, baselineValue) : undefined;
    const outputBaselinePath = writeBaselineFlag
        ? path.resolve(configDir, writeBaselineFlag.split('=')[1])
        : undefined;
    let baselineFingerprints = new Set();
    if (baselinePath && !outputBaselinePath) {
        try {
            baselineFingerprints = (0, baseline_1.loadBaseline)(baselinePath);
            console.error(`Baseline: ${baselinePath} (${baselineFingerprints.size} fingerprints)`);
        }
        catch (error) {
            console.error(`Baseline error: ${error.message}`);
            process.exit(2);
        }
    }
    let verifier = new engine_1.CodeVerifier({
        enableAbstractInterpretation: !disableAI,
        disabledRules: [...config.disable, ...cliDisable],
        severityOverrides: config.severities,
        baselineFingerprints,
        failOn,
        projectRoot,
    });
    try {
        let results;
        const projectResults = runProjectChecks && !isStdin
            ? [...new Set(targets.map((target) => {
                    const resolved = path.resolve(target);
                    return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
                }))].map((root) => (0, project_checks_1.verifyProject)(root, {
                build: true,
                tests: true,
                audit: true,
                expoDoctor: true,
            }))
            : [];
        if (isStdin) {
            const code = fs.readFileSync(0, 'utf-8');
            results = [await verifier.verifyCode(code, 'stdin.tsx')];
        }
        else {
            if (targets.length === 0) {
                console.error('Error: No target file or directory specified.');
                process.exit(1);
            }
            const allFiles = expandTargets(targets, config.exclude);
            const files = changedOnly ? filterChangedFiles(allFiles, targets) : allFiles;
            // No early exit when files is empty: mobile/deployment config scanners
            // below may still produce results for config-only targets.
            verifier = new engine_1.CodeVerifier({
                enableAbstractInterpretation: !disableAI,
                disabledRules: [...config.disable, ...cliDisable],
                severityOverrides: config.severities,
                projectSummaryIndex: project_summaries_1.ProjectSummaryIndex.fromFiles(allFiles),
                semanticAnalysisIndex: semantic_analysis_1.SemanticAnalysisIndex.fromFiles(allFiles),
                baselineFingerprints,
                failOn,
                projectRoot,
            });
            const signature = (0, scan_cache_1.projectSignature)(allFiles);
            const cachePath = cacheFlag
                ? path.resolve(process.cwd(), cacheFlag.includes('=') ? cacheFlag.split('=')[1] : '.codeverifier-cache.json')
                : null;
            const cache = cachePath ? new scan_cache_1.ScanCache(cachePath) : null;
            const optionsIdentity = JSON.stringify({ disableAI, disabled: [...config.disable, ...cliDisable].sort(),
                severities: config.severities, failOn, projectRoot,
                baseline: [...baselineFingerprints].sort() });
            let cacheHits = 0;
            results = (await (0, scan_cache_1.mapWithConcurrency)(files, workers, async (file) => {
                const key = (0, scan_cache_1.fileCacheKey)(file, signature, optionsIdentity);
                const cached = cache?.get(key);
                if (cached) {
                    cacheHits++;
                    return cached;
                }
                try {
                    const result = await verifier.verifyFile(file);
                    cache?.set(key, result);
                    return result;
                }
                catch (err) {
                    console.error(`Skipping ${file}: ${err.message}`);
                    return null;
                }
            })).filter((result) => result !== null);
            if (cache) {
                cache.save();
                console.error(`Cache: ${cacheHits}/${files.length} file result(s) reused from ${cachePath}`);
            }
            results.push(...(0, mobile_config_1.verifyMobileConfigs)(targets, {
                projectRoot,
                baselineFingerprints,
                failOn,
                disabledRules: [...config.disable, ...cliDisable],
                severityOverrides: config.severities,
            }));
            results.push(...(0, deployment_config_1.verifyDeploymentConfigs)(targets, {
                projectRoot, baselineFingerprints, failOn,
                disabledRules: [...config.disable, ...cliDisable], severityOverrides: config.severities,
            }));
            results.push(...(0, native_consistency_1.verifyNativeConsistency)(targets, {
                projectRoot, baselineFingerprints, failOn,
                disabledRules: [...config.disable, ...cliDisable], severityOverrides: config.severities,
            }));
            if (results.length === 0) {
                console.error('Error: No analyzable files or configuration files found in the given targets.');
                process.exit(1);
            }
        }
        if (outputBaselinePath) {
            const baselineDiagnostics = results.flatMap((result) => result.diagnostics);
            (0, baseline_1.writeBaseline)(outputBaselinePath, baselineDiagnostics);
            const uniqueFingerprints = new Set(baselineDiagnostics.map((item) => item.fingerprint).filter(Boolean)).size;
            console.error(`Baseline written: ${outputBaselinePath} (${baselineDiagnostics.length} findings, ${uniqueFingerprints} unique fingerprints)`);
        }
        if (format === 'json') {
            const payload = isStdin || results.length === 1 ? results[0] : results;
            console.log(llm_formatter_1.LLMFormatter.formatJSON((projectResults.length > 0 ? { files: payload, projects: projectResults } : payload)));
        }
        else if (format === 'sarif') {
            console.log((0, sarif_1.formatSARIF)(results, projectResults));
        }
        else if (format === 'summary') {
            for (const r of results)
                console.log(`${r.status.padEnd(10)} ${r.filePath} — ${r.summary}`);
            for (const project of projectResults)
                console.log((0, project_checks_1.formatProjectChecks)(project));
        }
        else if (format === 'report') {
            console.log((0, report_1.formatReport)(results));
            for (const project of projectResults)
                console.log(`\n${(0, project_checks_1.formatProjectChecks)(project)}`);
        }
        else {
            const failed = results.filter((r) => r.status !== 'PASSED');
            const passed = results.filter((r) => r.status === 'PASSED');
            if (passed.length > 0) {
                console.log(`✅ Passed (${passed.length}): ${passed.map((r) => path.basename(r.filePath)).join(', ')}\n`);
            }
            // Below-gate (advisory) findings on passing files stay visible here: the
            // severity gate keeps them non-blocking, not invisible.
            for (const advisory of passed.filter((r) => r.diagnostics.length > 0)) {
                const lines = advisory.diagnostics
                    .map((d) => `  [${d.severity}] ${d.ruleId} (L${d.loc.start.line}): ${d.message}`)
                    .join('\n');
                console.log(`⚠️  Advisory — ${path.basename(advisory.filePath)} (does not fail the run at the current gate):\n${lines}\n`);
            }
            for (const r of failed) {
                console.log(llm_formatter_1.LLMFormatter.formatForLLMPrompt(r));
                console.log('\n' + '-'.repeat(60) + '\n');
            }
            for (const project of projectResults)
                console.log(`\n${(0, project_checks_1.formatProjectChecks)(project)}`);
        }
        const anyFailed = results.some((r) => r.status === 'FAILED') || projectResults.some((r) => r.status === 'FAILED');
        const anyIncomplete = results.some((r) => r.status === 'INCOMPLETE') || projectResults.some((r) => r.status === 'INCOMPLETE');
        process.exit(outputBaselinePath ? (anyIncomplete ? 2 : 0) : anyFailed ? 1 : anyIncomplete ? 2 : 0);
    }
    catch (error) {
        console.error(`Verification error: ${error.message}`);
        process.exit(2);
    }
}
main();
function filterChangedFiles(files, targets) {
    const changed = new Set();
    const roots = [...new Set(targets.map((target) => {
            const resolved = path.resolve(target);
            return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
        }))];
    for (const root of roots) {
        const top = (0, child_process_1.spawnSync)('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
        if (top.status !== 0)
            continue;
        const repo = top.stdout.trim();
        for (const args of [['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'],
            ['ls-files', '--others', '--exclude-standard']]) {
            const output = (0, child_process_1.spawnSync)('git', ['-C', repo, ...args], { encoding: 'utf8' });
            if (output.status === 0)
                output.stdout.split(/\r?\n/).filter(Boolean)
                    .forEach((file) => changed.add(path.resolve(repo, file)));
        }
    }
    return files.filter((file) => changed.has(path.resolve(file)));
}
