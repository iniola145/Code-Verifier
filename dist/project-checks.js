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
exports.verifyProject = verifyProject;
exports.classifyESLintExit = classifyESLintExit;
exports.classifyNpmAuditExit = classifyNpmAuditExit;
exports.summarizeNpmAuditOutput = summarizeNpmAuditOutput;
exports.summarizeESLintOutput = summarizeESLintOutput;
exports.formatProjectChecks = formatProjectChecks;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const CONFIG_NAMES = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
];
function verifyProject(projectRoot, options = {}) {
    const root = path.resolve(projectRoot);
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
    const checks = [];
    if (options.typecheck !== false)
        checks.push(runTypeScript(root, timeoutMs, maxOutputBytes));
    if (options.eslint !== false)
        checks.push(runESLint(root, timeoutMs, maxOutputBytes));
    if (options.build)
        checks.push(runPackageScript(root, "build", "Build", timeoutMs, maxOutputBytes));
    if (options.tests)
        checks.push(runPackageScript(root, "test", "Tests", timeoutMs, maxOutputBytes));
    if (options.audit)
        checks.push(runNpmAudit(root, timeoutMs, maxOutputBytes));
    if (options.expoDoctor)
        checks.push(runExpoDoctor(root, timeoutMs, maxOutputBytes));
    const required = checks.filter((check) => check.required);
    const status = required.some((check) => check.status === "FAILED")
        ? "FAILED"
        : required.some((check) => check.status === "INCOMPLETE")
            ? "INCOMPLETE"
            : "PASSED";
    return {
        projectRoot: root,
        status,
        checks,
        summary: `${status}: ${checks.map((check) => `${check.name}=${check.status}`).join(", ")}`,
    };
}
function runTypeScript(root, timeoutMs, maxOutputBytes) {
    const config = path.join(root, "tsconfig.json");
    if (!fs.existsSync(config))
        return skipped("typescript", "TypeScript", "No tsconfig.json found.");
    return runLocalTool({
        root,
        id: "typescript",
        name: "TypeScript",
        binary: "tsc",
        args: ["--project", config, "--noEmit", "--pretty", "false"],
        timeoutMs,
        maxOutputBytes,
        classify: (code) => code === 0
            ? "PASSED"
            : code === 1 || code === 2
                ? "FAILED"
                : "INCOMPLETE",
    });
}
function runESLint(root, timeoutMs, maxOutputBytes) {
    const configured = CONFIG_NAMES.some((name) => fs.existsSync(path.join(root, name)));
    if (!configured)
        return skipped("eslint", "ESLint", "No ESLint configuration found.");
    return runLocalTool({
        root,
        id: "eslint",
        name: "ESLint",
        binary: "eslint",
        args: [".", "--format", "json"],
        timeoutMs,
        maxOutputBytes,
        classify: classifyESLintExit,
    });
}
function readPackage(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    }
    catch {
        return null;
    }
}
function runPackageScript(root, script, name, timeoutMs, maxOutputBytes) {
    const pkg = readPackage(root);
    if (!pkg?.scripts?.[script])
        return skipped(script, name, `No ${script} script declared.`);
    return runExecutable({
        root,
        id: script,
        name,
        executable: "npm",
        args: ["run", script],
        timeoutMs: Math.max(timeoutMs, 300_000),
        maxOutputBytes,
        classify: (code) => (code === 0 ? "PASSED" : "FAILED"),
        env: { CI: "true", VITEST_SKIP_INSTALL_CHECKS: "1" },
    });
}
function runNpmAudit(root, timeoutMs, maxOutputBytes) {
    if (!fs.existsSync(path.join(root, "package-lock.json")) &&
        !fs.existsSync(path.join(root, "npm-shrinkwrap.json"))) {
        return skipped("dependency-audit", "Dependency audit", "No npm lockfile found.");
    }
    return runExecutable({
        root,
        id: "dependency-audit",
        name: "Dependency audit",
        executable: "npm",
        args: ["audit", "--json", "--audit-level=high"],
        timeoutMs,
        maxOutputBytes,
        classify: classifyNpmAuditExit,
    });
}
function runExpoDoctor(root, timeoutMs, maxOutputBytes) {
    const pkg = readPackage(root);
    if (!pkg?.dependencies?.expo && !pkg?.devDependencies?.expo) {
        return skipped("expo-doctor", "Expo Doctor", "Project does not depend on Expo.");
    }
    const executable = path.join(root, "node_modules", ".bin", "expo-doctor");
    if (!fs.existsSync(executable)) {
        return incomplete("expo-doctor", "Expo Doctor", "Local expo-doctor binary not found; automatic downloads are disabled.");
    }
    return runExecutable({
        root,
        id: "expo-doctor",
        name: "Expo Doctor",
        executable,
        args: [],
        timeoutMs,
        maxOutputBytes,
        classify: (code) => code === 0 ? "PASSED" : code === 1 ? "FAILED" : "INCOMPLETE",
    });
}
function classifyESLintExit(code) {
    if (code === 0)
        return "PASSED";
    if (code === 1)
        return "FAILED";
    return "INCOMPLETE";
}
function classifyNpmAuditExit(code, output) {
    if (code === 0)
        return "PASSED";
    const report = parseEmbeddedJson(output);
    if (!report || report.error || !report.metadata?.vulnerabilities)
        return "INCOMPLETE";
    return code === 1 ? "FAILED" : "INCOMPLETE";
}
function runLocalTool(invocation) {
    const executable = path.join(invocation.root, "node_modules", ".bin", invocation.binary);
    if (!fs.existsSync(executable)) {
        return incomplete(invocation.id, invocation.name, `Local ${invocation.binary} binary not found. Install project dependencies.`);
    }
    return runExecutable({ ...invocation, executable });
}
function runExecutable(invocation) {
    const start = Date.now();
    const result = (0, child_process_1.spawnSync)(invocation.executable, invocation.args, {
        cwd: invocation.root,
        encoding: "utf8",
        shell: false,
        timeout: invocation.timeoutMs,
        maxBuffer: invocation.maxOutputBytes,
        env: { ...process.env, ...invocation.env },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const status = result.error
        ? "INCOMPLETE"
        : invocation.classify(result.status, output);
    return {
        id: invocation.id,
        name: invocation.name,
        status,
        required: true,
        command: `${path.basename(invocation.executable)} ${invocation.args.join(" ")}`,
        durationMs: Date.now() - start,
        exitCode: result.status,
        output: output.slice(0, 100_000),
        message: result.error?.message || summarizeToolOutput(invocation.id, output),
    };
}
function skipped(id, name, message) {
    return {
        id,
        name,
        status: "SKIPPED",
        required: false,
        durationMs: 0,
        message,
    };
}
function incomplete(id, name, message) {
    return {
        id,
        name,
        status: "INCOMPLETE",
        required: true,
        durationMs: 0,
        message,
    };
}
function summarizeToolOutput(id, output) {
    if (!output)
        return undefined;
    if (id === "eslint")
        return summarizeESLintOutput(output);
    if (id === "dependency-audit")
        return summarizeNpmAuditOutput(output);
    const firstLine = output.split(/\r?\n/).find((line) => line.trim());
    return firstLine?.slice(0, 500);
}
function summarizeNpmAuditOutput(output) {
    try {
        const report = parseEmbeddedJson(output);
        if (!report)
            throw new Error("No JSON report");
        if (report.error)
            return `Audit failed: ${report.error.summary || report.error.detail || report.message || report.error.message || "unknown registry error"}`;
        const counts = report.metadata?.vulnerabilities;
        if (!counts)
            return "Audit completed, but vulnerability totals were unavailable.";
        return `${counts.total ?? 0} vulnerabilities (critical: ${counts.critical ?? 0}, high: ${counts.high ?? 0}, moderate: ${counts.moderate ?? 0}, low: ${counts.low ?? 0})`;
    }
    catch {
        return (output
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.slice(0, 500) ?? "npm audit produced unreadable output.");
    }
}
function parseEmbeddedJson(output) {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end < start)
        return null;
    try {
        return JSON.parse(output.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
function summarizeESLintOutput(output) {
    try {
        const files = JSON.parse(output);
        const errors = files.reduce((sum, file) => sum + (file.errorCount ?? 0), 0);
        const warnings = files.reduce((sum, file) => sum + (file.warningCount ?? 0), 0);
        const affected = files.filter((file) => (file.errorCount ?? 0) + (file.warningCount ?? 0) > 0);
        const examples = affected
            .flatMap((file) => (file.messages ?? []).map((message) => `${path.relative(process.cwd(), file.filePath)}:${message.line ?? 1} ${message.ruleId ?? "eslint"} ${message.message}`))
            .slice(0, 3);
        return `${errors} error(s), ${warnings} warning(s) in ${affected.length} file(s)${examples.length ? `; ${examples.join("; ")}` : ""}`;
    }
    catch {
        return (output
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.slice(0, 500) ?? "ESLint produced unreadable output.");
    }
}
function formatProjectChecks(result) {
    const lines = [`Project checks: ${result.status} (${result.projectRoot})`];
    for (const check of result.checks) {
        lines.push(`- ${check.name}: ${check.status} (${check.durationMs}ms)${check.message ? ` - ${check.message}` : ""}`);
    }
    return lines.join("\n");
}
