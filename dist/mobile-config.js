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
exports.verifyMobileConfigs = verifyMobileConfigs;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const baseline_1 = require("./baseline");
const CONFIG_NAMES = new Set(["app.json", "AndroidManifest.xml", "Info.plist"]);
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
const RANK = {
    CRITICAL: 5,
    HIGH: 4,
    MEDIUM: 3,
    LOW: 2,
    INFO: 1,
};
function verifyMobileConfigs(targets, options) {
    return discoverConfigFiles(targets).map((file) => verifyMobileConfig(file, options));
}
function discoverConfigFiles(targets) {
    const found = new Set();
    const walk = (entry) => {
        if (!fs.existsSync(entry))
            return;
        const stat = fs.statSync(entry);
        if (stat.isFile()) {
            if (CONFIG_NAMES.has(path.basename(entry)))
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
            else if (CONFIG_NAMES.has(child.name))
                found.add(path.resolve(childPath));
        }
    };
    targets.forEach(walk);
    return [...found].sort();
}
function verifyMobileConfig(filePath, options) {
    const startTime = Date.now();
    const code = fs.readFileSync(filePath, "utf8");
    const lines = code.split(/\r?\n/);
    const diagnostics = [];
    // Debug source-set overlays (src/debug/, src/debugOptimized/, ...) merge
    // into debug builds only. Their dev-only relaxations — cleartext for local
    // servers, debuggable for tooling — can never reach a release build, so
    // they stay visible but advisory instead of blocking.
    const debugOverlay = /(?:^|[\\/])src[\\/]debug[^\\/]*[\\/]/i.test(filePath);
    const report = (ruleId, severity, message, explanation, remediation, search) => {
        const index = lines.findIndex((line) => line.includes(search));
        const line = index >= 0 ? index + 1 : 1;
        diagnostics.push({
            id: `${filePath}:${line}:0:${ruleId}`,
            ruleId,
            category: "SECURITY",
            severity,
            message,
            explanation,
            filePath,
            loc: {
                start: { line, column: 0 },
                end: { line, column: lines[index]?.length ?? 0 },
            },
            codeSnippet: lines[index] ?? "",
            remediation: { summary: remediation, llmPromptHint: remediation },
        });
    };
    try {
        if (path.basename(filePath) === "app.json") {
            const root = JSON.parse(code);
            const expo = root.expo ?? root;
            if (expo.android?.allowBackup === true)
                report("MOB-001", "MEDIUM", "Expo Android configuration explicitly enables application backup.", "Backups can include locally stored application data unless sensitive paths are explicitly excluded.", "Disable backup for sensitive applications or define narrowly scoped Android backup and extraction rules.", "allowBackup");
            if (expo.android?.usesCleartextTraffic === true)
                report("MOB-002", "HIGH", "Expo Android configuration permits cleartext network traffic.", "Cleartext HTTP traffic can be observed or modified in transit.", "Disable cleartext traffic and use HTTPS; use a narrow network security exception only when unavoidable.", "usesCleartextTraffic");
            if (expo.ios?.infoPlist?.NSAppTransportSecurity?.NSAllowsArbitraryLoads ===
                true)
                report("MOB-002", "HIGH", "Expo iOS configuration disables App Transport Security globally.", "Global arbitrary loads permit insecure HTTP and weaken platform transport requirements.", "Remove NSAllowsArbitraryLoads or replace it with the narrowest justified domain exception.", "NSAllowsArbitraryLoads");
            if (expo.ios?.infoPlist?.UIFileSharingEnabled === true)
                report("MOB-005", "MEDIUM", "Expo iOS configuration enables document sharing.", "Files in the application Documents directory become available through Finder or iTunes and may include sensitive application data.", "Disable UIFileSharingEnabled unless it is a deliberate product feature, and keep secrets outside Documents.", "UIFileSharingEnabled");
            const riskyPermissions = new Set([
                "READ_SMS",
                "RECEIVE_SMS",
                "MANAGE_EXTERNAL_STORAGE",
                "REQUEST_INSTALL_PACKAGES",
            ]);
            for (const permission of expo.android?.permissions ?? []) {
                const shortName = String(permission).replace(/^android\.permission\./, "");
                if (riskyPermissions.has(shortName))
                    report("MOB-006", "HIGH", `Expo configuration requests high-risk Android permission '${shortName}'.`, "This permission grants unusually broad access or enables sensitive platform behavior and increases compromise impact.", "Remove the permission unless it is essential; otherwise document the use case and constrain the affected feature.", String(permission));
            }
        }
        else if (path.basename(filePath) === "AndroidManifest.xml") {
            if (/android:allowBackup\s*=\s*["']true["']/.test(code)) {
                // Scoped backup/exclusion rules configured on the same manifest make
                // this an advisory check, not a likely data-exposure default.
                const hasScopedRules = /android:(?:fullBackupContent|dataExtractionRules)\s*=\s*["'][^"']+["']/.test(code);
                report("MOB-001", hasScopedRules ? "LOW" : "MEDIUM", hasScopedRules
                    ? "Android manifest enables application backup with scoped exclusion rules configured."
                    : "Android manifest explicitly enables application backup.", hasScopedRules
                    ? "Backup is only as safe as its exclusion rules; verify fullBackupContent/dataExtractionRules cover every sensitive path, including data written by dependencies."
                    : "Backups can disclose sensitive local data when exclusion rules are incomplete.", "Disable backup or configure dataExtractionRules/fullBackupContent to exclude every sensitive path.", "allowBackup");
            }
            if (/android:usesCleartextTraffic\s*=\s*["']true["']/.test(code))
                report("MOB-002", debugOverlay ? "LOW" : "HIGH", debugOverlay
                    ? "Debug build overlay permits cleartext network traffic (expected for development)."
                    : "Android manifest permits cleartext network traffic.", debugOverlay
                    ? "Cleartext traffic in a debug source set never ships to release builds; keep dev-only settings out of the main and release manifests."
                    : "Cleartext HTTP can be intercepted or modified.", "Set usesCleartextTraffic to false and use narrowly scoped network security configuration exceptions.", "usesCleartextTraffic");
            if (/android:debuggable\s*=\s*["']true["']/.test(code))
                report("MOB-004", debugOverlay ? "LOW" : "HIGH", debugOverlay
                    ? "Debug build overlay marks the application as debuggable (expected for development)."
                    : "Android manifest explicitly marks the application as debuggable.", debugOverlay
                    ? "Debuggable debug builds are expected for tooling; ensure release builds never inherit this attribute."
                    : "Debuggable production applications expose additional inspection and control capabilities to attackers.", "Remove the attribute from the release manifest or set it to false in production builds.", "debuggable");
            const components = /<(activity|activity-alias|service|receiver|provider)\b[^>]*android:exported\s*=\s*["']true["'][^>]*>/g;
            for (const match of code.matchAll(components)) {
                if (/android:permission\s*=/.test(match[0]))
                    continue;
                // The launcher entry activity MUST be exported for the app to open —
                // flagging it would fire on every Android app's most common pattern.
                if ((match[1] === "activity" || match[1] === "activity-alias") &&
                    !/\/>\s*$/.test(match[0]) &&
                    hasLauncherIntentFilter(code, (match.index ?? 0) + match[0].length, match[1]))
                    continue;
                report("MOB-003", "HIGH", `Exported Android ${match[1]} has no manifest permission.`, "Other applications may invoke an exported component; sensitive behavior without an access check can become a confused-deputy path.", "Set exported=false unless external access is required, or protect the component with an appropriate signature permission and runtime checks.", match[0]);
            }
        }
        else if (path.basename(filePath) === "Info.plist") {
            if (/<key>NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.test(code))
                report("MOB-002", "HIGH", "Info.plist disables App Transport Security globally.", "Global arbitrary loads permit insecure HTTP and weaken platform transport requirements.", "Remove NSAllowsArbitraryLoads or use a narrowly scoped, justified exception domain.", "NSAllowsArbitraryLoads");
            if (/<key>UIFileSharingEnabled<\/key>\s*<true\s*\/>/.test(code))
                report("MOB-005", "MEDIUM", "Info.plist enables document sharing.", "Files in the application Documents directory become available through Finder or iTunes and may include sensitive application data.", "Disable UIFileSharingEnabled unless it is intentional, and keep secrets outside Documents.", "UIFileSharingEnabled");
        }
    }
    catch (error) {
        return configParseFailure(filePath, lines.length, Date.now() - startTime, error.message);
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
        filePath,
        status,
        passed: status === "PASSED",
        diagnostics: active,
        checks: [
            {
                id: "mobile-config",
                name: "Mobile platform configuration",
                status: "PASSED",
                required: true,
            },
        ],
        stats: {
            totalLines: lines.length,
            blocksAnalyzed: 0,
            rulesChecked: 6,
            executionTimeMs: Date.now() - startTime,
            baselineSuppressed: fingerprinted.length - active.length,
            issuesCount: countSeverities(active),
        },
        summary: blocking > 0
            ? `Verification Failed: Found ${blocking} mobile configuration finding(s) at or above ${failOn}.`
            : `Verification Passed: No mobile configuration findings at or above ${failOn}.`,
    };
}
/**
 * True when the component whose opening tag ends at `tagEnd` declares an
 * intent-filter combining MAIN action with LAUNCHER category — i.e. it is
 * the app's launcher entry and must stay exported.
 */
function hasLauncherIntentFilter(code, tagEnd, tagName) {
    const bodyEnd = code.indexOf(`</${tagName}>`, tagEnd);
    if (bodyEnd < 0)
        return false;
    const body = code.slice(tagEnd, bodyEnd);
    for (const filter of body.matchAll(/<intent-filter\b[\s\S]*?<\/intent-filter>/g)) {
        if (/android\.intent\.action\.MAIN/.test(filter[0]) &&
            /android\.intent\.category\.LAUNCHER/.test(filter[0]))
            return true;
    }
    return false;
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
function configParseFailure(filePath, totalLines, duration, message) {
    return {
        filePath,
        status: "INCOMPLETE",
        passed: false,
        diagnostics: [],
        checks: [
            {
                id: "mobile-config",
                name: "Mobile platform configuration",
                status: "INCOMPLETE",
                required: true,
                message,
            },
        ],
        stats: {
            totalLines,
            blocksAnalyzed: 0,
            rulesChecked: 6,
            executionTimeMs: duration,
            issuesCount: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            failureType: "parse-error",
        },
        summary: `Verification Incomplete: mobile configuration could not be parsed (${message}).`,
    };
}
