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
exports.loadConfig = loadConfig;
exports.globToRegExp = globToRegExp;
exports.isExcluded = isExcluded;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DEFAULT_CONFIG = {
    exclude: [],
    disable: [],
    severities: {},
    failOn: "MEDIUM",
};
const VALID_SEVERITIES = new Set([
    "CRITICAL",
    "HIGH",
    "MEDIUM",
    "LOW",
    "INFO",
]);
const CONFIG_KEYS = new Set([
    "exclude",
    "disable",
    "severities",
    "baseline",
    "failOn",
]);
function validateStringArray(raw, key, errors) {
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
        errors.push(`"${key}" must be an array of strings.`);
        return [];
    }
    return raw;
}
function validateSeverities(raw, errors) {
    const out = {};
    if (raw === undefined)
        return out;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push('"severities" must be an object mapping rule ids to severities.');
        return out;
    }
    for (const [ruleId, sev] of Object.entries(raw)) {
        if (VALID_SEVERITIES.has(sev))
            out[ruleId] = sev;
        else
            errors.push(`"severities.${ruleId}" must be CRITICAL, HIGH, MEDIUM, LOW, or INFO.`);
    }
    return out;
}
/**
 * Finds the nearest .codeverifier.json, walking up from `startDir` to the
 * filesystem root. Returns the default config when none exists.
 */
function loadConfig(startDir) {
    let dir = path.resolve(startDir);
    while (true) {
        const candidate = path.join(dir, ".codeverifier.json");
        if (fs.existsSync(candidate)) {
            try {
                const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                    return {
                        config: DEFAULT_CONFIG,
                        configPath: candidate,
                        errors: ["Configuration root must be an object."],
                    };
                }
                const value = raw;
                const errors = [];
                for (const key of Object.keys(value)) {
                    if (!CONFIG_KEYS.has(key))
                        errors.push(`Unknown configuration key "${key}".`);
                }
                const failOn = value.failOn === undefined ? "MEDIUM" : value.failOn;
                if (!VALID_SEVERITIES.has(failOn)) {
                    errors.push('"failOn" must be CRITICAL, HIGH, MEDIUM, LOW, or INFO.');
                }
                if (value.baseline !== undefined &&
                    typeof value.baseline !== "string") {
                    errors.push('"baseline" must be a file path string.');
                }
                return {
                    config: {
                        exclude: validateStringArray(value.exclude, "exclude", errors),
                        disable: validateStringArray(value.disable, "disable", errors),
                        severities: validateSeverities(value.severities, errors),
                        baseline: typeof value.baseline === "string" ? value.baseline : undefined,
                        failOn: VALID_SEVERITIES.has(failOn)
                            ? failOn
                            : "MEDIUM",
                    },
                    configPath: candidate,
                    errors,
                };
            }
            catch (error) {
                return {
                    config: DEFAULT_CONFIG,
                    configPath: candidate,
                    errors: [`Could not parse configuration: ${error.message}`],
                };
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return { config: DEFAULT_CONFIG, configPath: null, errors: [] };
        dir = parent;
    }
}
/**
 * Simple glob -> RegExp: a globstar crosses directories, `*` stays within
 * one segment, `?` is one char. A leading globstar-slash also matches at
 * the root.
 */
function globToRegExp(pattern) {
    const leadingGlobstar = pattern.startsWith("**/");
    const core = leadingGlobstar ? pattern.slice(3) : pattern;
    let re = "";
    for (let i = 0; i < core.length; i++) {
        const ch = core[i];
        if (core.startsWith("**", i)) {
            re += ".*";
            i++;
        }
        else if (ch === "*") {
            re += "[^/]*";
        }
        else if (ch === "?") {
            re += "[^/]";
        }
        else if ("\\^$.+?()[]{}|/".includes(ch)) {
            re += "\\" + ch;
        }
        else {
            re += ch;
        }
    }
    const body = leadingGlobstar ? `(?:.*/)?${re}` : re;
    return new RegExp(`^${body}$`);
}
/** True when a path matches any exclude glob (also tried on the basename). */
function isExcluded(filePath, patterns) {
    const normalized = filePath.split(path.sep).join("/");
    for (const p of patterns) {
        try {
            const re = globToRegExp(p);
            if (re.test(normalized) || re.test(path.basename(normalized)))
                return true;
        }
        catch {
            return true; // broken pattern: exclude to be safe
        }
    }
    return false;
}
