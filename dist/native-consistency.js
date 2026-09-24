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
exports.verifyNativeConsistency = verifyNativeConsistency;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const baseline_1 = require("./baseline");
const SKIP_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    ".git",
    ".expo",
    ".gradle",
    "coverage",
    "Pods",
    "DerivedData",
]);
const SOURCE_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
]);
const RANK = {
    CRITICAL: 5,
    HIGH: 4,
    MEDIUM: 3,
    LOW: 2,
    INFO: 1,
};
/**
 * Cross-checks JS imports against the checked-out native app: a package that
 * ships an iOS podspec (Expo SDK packages, community RN libraries) but whose
 * pod is absent from ios/Podfile.lock means the native app was built before
 * the dependency was added. The JS import resolves while the native side
 * throws "Cannot find native module 'X'" at runtime.
 */
function verifyNativeConsistency(targets, options) {
    return discoverLockfiles(targets).map((lockfile) => verifyLockfile(lockfile, options));
}
function discoverLockfiles(targets) {
    const found = new Set();
    const walk = (entry) => {
        if (!fs.existsSync(entry))
            return;
        const stat = fs.statSync(entry);
        if (stat.isFile()) {
            if (path.basename(entry) === "Podfile.lock")
                found.add(path.resolve(entry));
            return;
        }
        if (!stat.isDirectory())
            return;
        for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
            if (child.isDirectory() && SKIP_DIRS.has(child.name))
                continue;
            const childPath = path.join(entry, child.name);
            if (child.isDirectory())
                walk(childPath);
            else if (child.name === "Podfile.lock")
                found.add(path.resolve(childPath));
        }
    };
    targets.forEach(walk);
    return [...found].sort();
}
/** Pod names declared in `  - "Name (version)"` lines of a CocoaPods lockfile. */
function podNamesFromLockfile(code) {
    const pods = new Set();
    for (const match of code.matchAll(/^  - "?([A-Za-z0-9_.\-]+)"? \(/gm))
        pods.add(match[1]);
    return pods;
}
/** Package name for a module specifier: subpaths/queries stripped, scoped packages keep two segments. */
function basePackageName(specifier) {
    const cleaned = specifier.split("?")[0];
    if (!cleaned ||
        cleaned.startsWith(".") ||
        cleaned.startsWith("/") ||
        /^[a-z]+:/i.test(cleaned))
        return null;
    const segments = cleaned.split("/");
    return segments[0].startsWith("@")
        ? segments.slice(0, 2).join("/")
        : segments[0];
}
const IMPORT_PATTERNS = [
    /\bimport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
/**
 * Walks the project containing the lockfile's ios/ directory and maps every
 * imported package to the source files importing it.
 */
function collectImportedPackages(appBase, projectRoot) {
    const imports = new Map();
    const record = (specifier, file) => {
        const pkg = basePackageName(specifier);
        if (!pkg)
            return;
        const files = imports.get(pkg) ?? [];
        if (files.length < 5 && !files.includes(file))
            files.push(file);
        imports.set(pkg, files);
    };
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory() && SKIP_DIRS.has(entry.name))
                continue;
            if (entry.name.startsWith("."))
                continue;
            const child = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(child);
            }
            else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
                !entry.name.endsWith(".d.ts")) {
                try {
                    const code = fs.readFileSync(child, "utf8");
                    const rel = path.relative(projectRoot, child) || child;
                    for (const pattern of IMPORT_PATTERNS) {
                        for (const match of code.matchAll(pattern))
                            record(match[1], rel);
                    }
                }
                catch {
                    // Unreadable file — not evidence about imports; skip it.
                }
            }
        }
    };
    if (fs.existsSync(appBase))
        walk(appBase);
    return imports;
}
/**
 * iOS pod names a package would contribute under autolinking, read from the
 * package's own podspec files (root and ios/ layouts). An empty result means
 * the package contributes no iOS-native code — nothing to check.
 */
function podNamesForPackage(appBase, pkg) {
    const pkgDir = path.join(appBase, "node_modules", pkg);
    const names = new Set();
    for (const dir of [pkgDir, path.join(pkgDir, "ios")]) {
        let entries;
        try {
            entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.endsWith(".podspec") && !entry.endsWith(".podspec.json"))
                continue;
            try {
                const text = fs.readFileSync(path.join(dir, entry), "utf8");
                if (entry.endsWith(".podspec.json")) {
                    const parsed = JSON.parse(text);
                    if (typeof parsed?.name === "string")
                        names.add(parsed.name);
                }
                else {
                    const name = text.match(/^\s*s\.name\s*=\s*['"]([^'"]+)['"]/m)?.[1];
                    if (name)
                        names.add(name);
                }
            }
            catch {
                // Unreadable or malformed podspec — its absence from the lockfile is not provable.
            }
        }
    }
    return [...names];
}
function verifyLockfile(lockfilePath, options) {
    const startTime = Date.now();
    const code = fs.readFileSync(lockfilePath, "utf8");
    const lines = code.split(/\r?\n/);
    const diagnostics = [];
    try {
        const iosDir = path.dirname(lockfilePath);
        const appBase = path.dirname(iosDir);
        const pods = podNamesFromLockfile(code);
        if (pods.size > 0) {
            const imported = collectImportedPackages(appBase, options.projectRoot);
            for (const [pkg, files] of [...imported.entries()].sort()) {
                const podNames = podNamesForPackage(appBase, pkg);
                if (podNames.length === 0 || podNames.some((name) => pods.has(name)))
                    continue;
                const podList = podNames.map((name) => `'${name}'`).join(", ");
                diagnostics.push({
                    id: `${lockfilePath}:1:0:NAT-001`,
                    filePath: lockfilePath,
                    ruleId: "NAT-001",
                    category: "REACT_NATIVE_EXPO",
                    severity: "HIGH",
                    message: `Package '${pkg}' declares native iOS pod(s) ${podList} that are missing from ios/Podfile.lock — the checked-out native app is stale.`,
                    explanation: `Autolinking installs native modules at native build time. '${pkg}' is imported in ${files.length === 1 ? "a source file" : `${files.length} source files`} (${files.join(", ")}), but its pod is not in the lockfile, so the installed app binary predates the dependency. The JS import resolves while the native side throws "Cannot find native module ..." at runtime.`,
                    loc: {
                        start: { line: 1, column: 0 },
                        end: { line: 1, column: lines[0]?.length ?? 0 },
                    },
                    codeSnippet: lines[0] ?? "",
                    remediation: {
                        summary: "Run pod install and rebuild the native app before running the JS bundle (e.g. `npx expo run:ios`, or `npx expo prebuild --clean` then rebuild; on Android, `npx expo run:android`).",
                        llmPromptHint: `The dependency '${pkg}' was added but the native iOS app was never rebuilt: its pod (${podList}) is absent from ios/Podfile.lock. Run pod install and a full native rebuild, then verify the module's native side exists before using it.`,
                    },
                });
            }
        }
    }
    catch (error) {
        return failureResult(lockfilePath, lines.length, Date.now() - startTime, error.message);
    }
    const disabled = options.disabledRules ?? [];
    const fingerprinted = diagnostics
        .filter((item) => !disabled.some((rule) => item.ruleId === rule || item.ruleId.startsWith(`${rule}-`)))
        .map((item) => options.severityOverrides?.[item.ruleId]
        ? { ...item, severity: options.severityOverrides[item.ruleId] }
        : item)
        .map((item) => ({
        ...item,
        fingerprint: (0, baseline_1.diagnosticFingerprint)(item, lines, options.projectRoot),
        confidence: "HIGH",
    }));
    const active = fingerprinted.filter((item) => !options.baselineFingerprints?.has(item.fingerprint));
    const failOn = options.failOn ?? "MEDIUM";
    const blocking = active.filter((item) => RANK[item.severity] >= RANK[failOn]).length;
    const status = blocking > 0 ? "FAILED" : "PASSED";
    return {
        filePath: lockfilePath,
        status,
        passed: status === "PASSED",
        diagnostics: active,
        checks: [
            {
                id: "native-consistency",
                name: "Native module consistency",
                status: "PASSED",
                required: true,
            },
        ],
        stats: {
            totalLines: lines.length,
            blocksAnalyzed: 0,
            rulesChecked: 1,
            executionTimeMs: Date.now() - startTime,
            baselineSuppressed: fingerprinted.length - active.length,
            issuesCount: countSeverities(active),
        },
        summary: blocking > 0
            ? `Verification Failed: ${blocking} imported native module(s) missing from the Podfile.lock.`
            : `Verification Passed: no imported native modules missing from the Podfile.lock.`,
    };
}
function countSeverities(items) {
    return {
        critical: items.filter((item) => item.severity === "CRITICAL").length,
        high: items.filter((item) => item.severity === "HIGH").length,
        medium: items.filter((item) => item.severity === "MEDIUM").length,
        low: items.filter((item) => item.severity === "LOW").length,
        info: items.filter((item) => item.severity === "INFO").length,
    };
}
function failureResult(filePath, totalLines, duration, message) {
    return {
        filePath,
        status: "INCOMPLETE",
        passed: false,
        diagnostics: [],
        checks: [
            {
                id: "native-consistency",
                name: "Native module consistency",
                status: "INCOMPLETE",
                required: true,
                message,
            },
        ],
        stats: {
            totalLines,
            blocksAnalyzed: 0,
            rulesChecked: 1,
            executionTimeMs: duration,
            issuesCount: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            failureType: "parse-error",
        },
        summary: `Verification Incomplete: native module consistency could not be checked (${message}).`,
    };
}
