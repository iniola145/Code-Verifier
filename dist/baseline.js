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
exports.diagnosticFingerprint = diagnosticFingerprint;
exports.loadBaseline = loadBaseline;
exports.writeBaseline = writeBaseline;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function diagnosticFingerprint(diagnostic, lines, projectRoot) {
    const relativePath = projectRoot
        ? path.relative(path.resolve(projectRoot), path.resolve(diagnostic.filePath))
        : path.basename(diagnostic.filePath);
    const source = lines
        .slice(Math.max(0, diagnostic.loc.start.line - 1), Math.max(diagnostic.loc.start.line, diagnostic.loc.end.line))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    const identity = [
        diagnostic.ruleId,
        relativePath.split(path.sep).join("/"),
        source,
        diagnostic.message,
    ].join("\0");
    return (0, crypto_1.createHash)("sha256").update(identity).digest("hex");
}
function loadBaseline(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (raw.version !== 1 ||
        !Array.isArray(raw.fingerprints) ||
        raw.fingerprints.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
        throw new Error(`Invalid baseline format: ${filePath}`);
    }
    return new Set(raw.fingerprints);
}
function writeBaseline(filePath, diagnostics) {
    const baseline = {
        version: 1,
        fingerprints: [
            ...new Set(diagnostics
                .map((item) => item.fingerprint)
                .filter((value) => !!value)),
        ].sort(),
    };
    fs.writeFileSync(filePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}
