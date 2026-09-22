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
exports.ScanCache = void 0;
exports.projectSignature = projectSignature;
exports.fileCacheKey = fileCacheKey;
exports.mapWithConcurrency = mapWithConcurrency;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class ScanCache {
    filePath;
    entries;
    constructor(filePath) {
        this.filePath = filePath;
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            this.entries = parsed.version === 1 && parsed.entries ? parsed.entries : {};
        }
        catch {
            this.entries = {};
        }
    }
    get(key) { return this.entries[key]; }
    set(key, value) { this.entries[key] = value; }
    save() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, `${JSON.stringify({ version: 1, entries: this.entries })}\n`, 'utf8');
    }
}
exports.ScanCache = ScanCache;
function projectSignature(files) {
    const hash = (0, crypto_1.createHash)('sha256');
    for (const file of [...files].sort()) {
        const stat = fs.statSync(file);
        hash.update(path.resolve(file)).update('\0').update(String(stat.size)).update('\0').update(String(stat.mtimeMs));
    }
    return hash.digest('hex');
}
function fileCacheKey(filePath, signature, optionsIdentity) {
    return (0, crypto_1.createHash)('sha256').update(fs.readFileSync(filePath)).update('\0').update(signature)
        .update('\0').update(optionsIdentity).digest('hex');
}
async function mapWithConcurrency(items, concurrency, work) {
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length)
                return;
            results[index] = await work(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
    return results;
}
