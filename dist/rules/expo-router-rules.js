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
exports.EXPOROUTER_RULES = void 0;
const path = __importStar(require("path"));
const ast_1 = require("../parser/ast");
/**
 * Expo Router conventions (https://docs.expo.dev/router/basics/notation/):
 * every file under app/ (or src/app/) is a route and must default-export a
 * React component. Ignored: dot-files, `.d.ts`, `*.{test,spec,config}.*`,
 * anything under a `_`-prefixed directory, and `_`-prefixed files other than
 * `_layout*`. `+api.ts` API routes export HTTP method handlers instead of a
 * default component; every other `+` special file still needs a default.
 */
const ROUTE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
/** Returns the path segments below the router root (app/ or src/app/), or null when the file is not inside one. */
function segmentsBelowRouterRoot(filePath, projectRoot) {
    let rel;
    if (projectRoot) {
        rel = path.relative(projectRoot, filePath);
        // File outside the project root — fall back to the raw path.
        if (rel.startsWith("..") || path.isAbsolute(rel))
            rel = filePath;
    }
    else {
        // Without a project root only a top-level app/ or src/app/ on the given
        // path is provable; deeper app/ segments (src/features/app/) would be a guess.
        rel = filePath;
    }
    const segments = rel.split(/[\\/]/).filter((s) => s.length > 0 && s !== ".");
    if (segments[0] === "app")
        return segments.slice(1);
    if (segments[0] === "src" && segments[1] === "app")
        return segments.slice(2);
    return null;
}
/** True when the segments below the router root name a file expo-router would try to load as a route. */
function isRouteCandidate(segments) {
    if (segments.length === 0)
        return false;
    const directories = segments.slice(0, -1);
    const base = segments[segments.length - 1];
    // Expo Router never loads dot-files or declaration files.
    if (base.startsWith(".") || base.endsWith(".d.ts"))
        return false;
    const ext = path.extname(base);
    if (!ROUTE_EXTENSIONS.has(ext))
        return false;
    // Ignored suffixes: tests, specs, and config files sitting inside app/.
    if (/\.(?:test|spec|config)\.[cm]?[jt]sx?$/.test(base))
        return false;
    const stem = base.slice(0, base.length - ext.length);
    // `_`-prefixed directories are non-route shared code; `_layout*` files are the exception that IS a route.
    if (directories.some((dir) => dir.startsWith("_") || dir.startsWith(".")))
        return false;
    if (base.startsWith("_") && !base.startsWith("_layout"))
        return false;
    // `+api` routes (e.g. users+api.ts) export GET/POST handlers, not a component.
    if (stem.endsWith("+api") || stem === "+api")
        return false;
    return true;
}
/** Detects every default-export shape: `export default X`, `export { X as default }`, `export { default } from`, `export * as default`. */
function hasDefaultExport(ast) {
    const body = ast?.program?.body ?? ast?.body ?? [];
    for (const node of body) {
        if (!node || typeof node.type !== "string")
            continue;
        if (node.type === "ExportDefaultDeclaration")
            return true;
        if (node.type === "ExportNamedDeclaration" &&
            node.specifiers?.some((spec) => spec.exported?.name === "default" ||
                spec.exported?.value === "default"))
            return true;
        if (node.type === "ExportAllDeclaration" &&
            (node.exported?.name === "default" || node.exported?.value === "default"))
            return true;
    }
    return false;
}
exports.EXPOROUTER_RULES = [
    {
        id: "NAV-001",
        name: "Expo Router Route Missing Default Export",
        description: "Detects Expo Router route files under app/ that do not default-export a React component.",
        category: "REACT_NATIVE_EXPO",
        defaultSeverity: "HIGH",
        check(ctx) {
            const segments = segmentsBelowRouterRoot(ctx.filePath, ctx.projectRoot);
            if (!segments || !isRouteCandidate(segments))
                return;
            if (hasDefaultExport(ctx.ast))
                return;
            const routeStem = segments[segments.length - 1].replace(/\.[cm]?[jt]sx?$/, "");
            const routeName = [...segments.slice(0, -1), routeStem].join("/");
            const loc = {
                start: { line: 1, column: 0 },
                end: { line: 1, column: ctx.lines[0]?.length ?? 0 },
            };
            ctx.report({
                id: `${ctx.filePath}:1:0:NAV-001`,
                ruleId: "NAV-001",
                category: "REACT_NATIVE_EXPO",
                severity: "HIGH",
                message: `Expo Router route "app/${routeName}" is missing the required default export.`,
                explanation: `Expo Router treats every file under app/ (or src/app/) as a route, and a route must default-export a React component. Without one, Metro logs "Route ... is missing the required default export" and navigating to app/${routeName} renders nothing or throws at runtime.`,
                loc,
                codeSnippet: (0, ast_1.extractCodeSnippet)(ctx.lines, loc),
                remediation: {
                    summary: "Add a default export: `export default function Screen() { ... }`, or re-export an existing component with `export { Screen as default }` / `export { default } from './Other'`.",
                    llmPromptHint: "Add a default-exported React component to this Expo Router route file. Expo Router requires every route file to have exactly one default export.",
                },
            });
        },
    },
];
