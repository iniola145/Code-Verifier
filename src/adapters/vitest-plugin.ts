import * as fs from "fs";
import * as path from "path";
import { TraceEvent } from "../runtime/types";

export interface VitestPluginOptions {
  outputFile?: string;
  captureConsole?: boolean;
}

/**
 * Vitest plugin that captures test results and runtime traces for Code Verifier analysis.
 * Usage in vitest.config.ts:
 *   import codeVerifierPlugin from 'code-verifier/vitest-plugin';
 *   export default defineConfig({ plugins: [codeVerifierPlugin()] });
 */
export default function codeVerifierPlugin(options?: VitestPluginOptions): any {
  const traceEvents: TraceEvent[] = [];
  const outputFile =
    options?.outputFile || process.env.CODE_VERIFIER_TRACE_FILE;

  function writeTraceFile() {
    if (outputFile && traceEvents.length > 0) {
      try {
        const dir = path.dirname(outputFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const jsonl = traceEvents.map((e) => JSON.stringify(e)).join("\n");
        fs.writeFileSync(outputFile, jsonl, "utf-8");
      } catch (err: any) {
        process.stderr.write(
          `[code-verifier] Failed to write Vitest trace file: ${err?.message || err}\n`,
        );
      }
    }
  }

  return {
    name: "code-verifier",
    enforce: "post" as const,

    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        next();
      });
    },

    transform(code: string, id: string) {
      if (
        id.includes(".test.") ||
        id.includes(".spec.") ||
        id.endsWith("_test.ts") ||
        id.endsWith("_test.tsx")
      ) {
        return injectErrorCapture(code, id);
      }
      return code;
    },

    onTestFinished(test: any) {
      if (test.result?.state === "failed") {
        const failures = test.result?.errors || [];
        traceEvents.push({
          type: "assertion_failed",
          testName: test.name || "Unknown Test",
          failureMessages: failures.map((e: any) => e.message || String(e)),
          message: failures[0]?.message || "Test failed",
          filePath: test.file?.name || "unknown",
          ts: Date.now(),
        });
      }
    },

    buildEnd() {
      writeTraceFile();
    },

    closeBundle() {
      writeTraceFile();
    },

    getTraceEvents(): TraceEvent[] {
      return traceEvents;
    },
  };
}

function injectErrorCapture(code: string, id: string): string {
  const preamble = `
if (typeof process !== 'undefined' && process.on) {
  process.on('unhandledRejection', (reason) => {
    console.error('[code-verifier] unhandledRejection:', reason);
  });
}
`;
  return `${preamble}\n${code}`;
}

// CommonJS compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = codeVerifierPlugin;
  (codeVerifierPlugin as any).default = codeVerifierPlugin;
}
