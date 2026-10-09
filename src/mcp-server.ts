import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { CodeVerifier } from "./engine";
import { LLMFormatter } from "./formatter/llm-formatter";
import { analyzeRuntimeTraces } from "./runtime/runtime-engine";
import { parseTraceFile } from "./runtime/trace-parser";
import { generateTestsForFile } from "./test-gen/generator";
import { TestFramework } from "./test-gen/types";
import { createSession, loadSession, updateSession } from "./tdr/session-manager";
import { verifyFix } from "./tdr/fix-verifier";

/**
 * Lightweight JSON-RPC Model Context Protocol (MCP) Server
 * Exposes 'verify_code' tool to any LLM Agent via stdio.
 */
class MCPServer {
  private verifier = new CodeVerifier();

  public start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        await this.handleMessage(message);
      } catch (err: any) {
        this.sendError(null, -32700, `Parse error: ${err.message}`);
      }
    });
  }

  private async handleMessage(msg: any): Promise<void> {
    const { id, method, params } = msg;

    if (method === "initialize") {
      this.sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "code-verifier-mcp",
          version: "1.0.0",
        },
      });
      return;
    }

    if (method === "tools/list") {
      this.sendResponse(id, {
        tools: [
          {
            name: "verify_code",
            description:
              "Verifies React, React Native, and Expo TypeScript code using SAST and Abstract Interpretation. Checks for security leaks (AsyncStorage, secrets, XSS in WebViews), React Hook violations (infinite re-render loops, conditional hooks), and null dereferences.",
            inputSchema: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  description: "The TypeScript/TSX/JSX source code to verify",
                },
                filePath: {
                  type: "string",
                  description:
                    "Optional filename (e.g. App.tsx, ProfileScreen.tsx)",
                  default: "Component.tsx",
                },
                format: {
                  type: "string",
                  enum: ["llm", "json"],
                  description:
                    "Format of diagnostic output (llm prompt markdown or raw json)",
                  default: "llm",
                },
              },
              required: ["code"],
            },
          },
          {
            name: "generate_tests",
            description:
              "Generate test suite from static analysis. Returns test file content.",
            inputSchema: {
              type: "object",
              properties: {
                filePath: {
                  type: "string",
                  description: "Source file to generate tests for",
                },
                code: {
                  type: "string",
                  description:
                    "Optional source code if not reading from file directly",
                },
                framework: {
                  type: "string",
                  enum: ["jest", "vitest", "detox"],
                  description: "Test framework (auto-detected if not specified)",
                },
                ruleFilter: {
                  type: "array",
                  items: { type: "string" },
                  description: "Only generate tests for these rule IDs",
                },
              },
              required: ["filePath"],
            },
          },
          {
            name: "get_runtime_findings",
            description:
              "Get runtime findings from a trace file. Returns confirmed bugs with evidence.",
            inputSchema: {
              type: "object",
              properties: {
                traceFile: {
                  type: "string",
                  description: "Path to JSONL trace file",
                },
                staticResultsFile: {
                  type: "string",
                  description:
                    "Optional path to static analysis results JSON",
                },
              },
              required: ["traceFile"],
            },
          },
          {
            name: "start_tdr_session",
            description:
              "Start a TDR session. Returns session ID, static findings, and generated tests.",
            inputSchema: {
              type: "object",
              properties: {
                sourceFile: {
                  type: "string",
                  description: "Source file to analyze",
                },
                framework: {
                  type: "string",
                  enum: ["jest", "vitest", "detox"],
                  description: "Test framework (auto-detected if not specified)",
                },
              },
              required: ["sourceFile"],
            },
          },
          {
            name: "verify_fix",
            description:
              "Verify that a fix resolves a finding. Returns verification result.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "TDR session ID",
                },
                sourceFile: {
                  type: "string",
                  description: "Source file that was fixed",
                },
                runTests: {
                  type: "boolean",
                  description: "Whether to run tests to verify the fix",
                  default: true,
                },
                testCommand: {
                  type: "string",
                  description: "Custom test command to execute",
                },
              },
              required: ["sessionId", "sourceFile"],
            },
          },
          {
            name: "get_tdr_status",
            description: "Get the status of a TDR session.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "TDR session ID",
                },
              },
              required: ["sessionId"],
            },
          },
        ],
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === "verify_code") {
        const code = args.code;
        const filePath = args.filePath || "Component.tsx";
        const format = args.format || "llm";

        try {
          const result = await this.verifier.verifyCode(code, filePath);
          const outputText =
            format === "json"
              ? LLMFormatter.formatJSON(result)
              : LLMFormatter.formatForLLMPrompt(result);

          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: outputText,
              },
            ],
            isError: result.status !== "PASSED",
          });
        } catch (err: any) {
          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Error verifying code: ${err.message}`,
              },
            ],
            isError: true,
          });
        }
        return;
      }

      if (toolName === "generate_tests") {
        const filePath = args.filePath || "Component.tsx";
        const framework = args.framework as TestFramework | undefined;
        const ruleFilter = args.ruleFilter;
        const code = args.code;

        try {
          const result = await generateTestsForFile(
            filePath,
            {
              framework,
              mode: "directory",
              ruleFilter,
              includeSetup: true,
            },
            code,
          );

          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: result.content,
              },
            ],
            isError: false,
          });
        } catch (err: any) {
          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Error generating tests: ${err.message}`,
              },
            ],
            isError: true,
          });
        }
        return;
      }

      if (toolName === "get_runtime_findings") {
        const traceFile = args.traceFile;
        const staticResultsFile = args.staticResultsFile;

        try {
          const traces = parseTraceFile(traceFile);
          const staticFindings =
            staticResultsFile && fs.existsSync(staticResultsFile)
              ? JSON.parse(fs.readFileSync(staticResultsFile, "utf-8"))
              : undefined;

          const findings = analyzeRuntimeTraces(traces, staticFindings);

          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(findings, null, 2),
              },
            ],
            isError: false,
          });
        } catch (err: any) {
          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Runtime analysis error: ${err.message}`,
              },
            ],
            isError: true,
          });
        }
        return;
      }

      if (toolName === "start_tdr_session") {
        const sourceFile = args.sourceFile;
        const framework = args.framework;

        try {
          if (!sourceFile) {
            throw new Error("sourceFile is required");
          }
          const resolvedPath = path.resolve(sourceFile);
          if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File not found: ${sourceFile}`);
          }
          const code = fs.readFileSync(resolvedPath, "utf-8");
          const result = await this.verifier.verifyCode(code, resolvedPath);
          const tests = await generateTestsForFile(resolvedPath, {
            framework: framework as TestFramework | undefined,
            mode: "directory",
          });
          const session = createSession(resolvedPath, result.diagnostics, [tests]);

          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    sessionId: session.id,
                    status: session.status,
                    sourceFile: session.sourceFile,
                    findings: session.originalFindings,
                    generatedTests: tests.content,
                    existingTestFound: session.existingTestFound,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: false,
          });
        } catch (err: any) {
          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Error starting TDR session: ${err.message}`,
              },
            ],
            isError: true,
          });
        }
        return;
      }

      if (toolName === "verify_fix") {
        const sessionId = args.sessionId;
        const sourceFile = args.sourceFile;
        const runTests = args.runTests;
        const testCommand = args.testCommand;

        try {
          if (!sessionId) {
            throw new Error("sessionId is required");
          }
          const session = loadSession(sessionId);
          if (!session) {
            this.sendResponse(id, {
              content: [
                {
                  type: "text",
                  text: `Session not found: ${sessionId}`,
                },
              ],
              isError: true,
            });
            return;
          }

          const resolvedFile = sourceFile
            ? path.resolve(sourceFile)
            : session.sourceFile;

          const result = await verifyFix(
            resolvedFile,
            session.originalFindings,
            {
              runTests: runTests !== false,
              testCommand,
              testFile: session.generatedTests[0]?.filePath,
              verifier: this.verifier,
            },
          );

          const nextStatus = result.fixed
            ? "verified"
            : result.testResult && !result.testResult.passed
              ? "tests_failing"
              : "fixed";

          updateSession(sessionId, {
            status: nextStatus,
            verificationResult: result,
          });

          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    sessionId,
                    status: nextStatus,
                    ...result,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: !result.fixed,
          });
        } catch (err: any) {
          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Error verifying fix: ${err.message}`,
              },
            ],
            isError: true,
          });
        }
        return;
      }

      if (toolName === "get_tdr_status") {
        const sessionId = args.sessionId;

        try {
          if (!sessionId) {
            throw new Error("sessionId is required");
          }
          const session = loadSession(sessionId);
          if (!session) {
            this.sendResponse(id, {
              content: [
                {
                  type: "text",
                  text: `Session not found: ${sessionId}`,
                },
              ],
              isError: true,
            });
            return;
          }

          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(session, null, 2),
              },
            ],
            isError: false,
          });
        } catch (err: any) {
          this.sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Error getting TDR status: ${err.message}`,
              },
            ],
            isError: true,
          });
        }
        return;
      }

      this.sendError(id, -32601, `Tool not found: ${toolName}`);
      return;
    }

    if (method === "ping") {
      this.sendResponse(id, {});
      return;
    }

    // Default response for unhandled notifications/methods
    if (id !== undefined) {
      this.sendError(id, -32601, `Method not found: ${method}`);
    }
  }

  private sendResponse(id: any, result: any): void {
    const payload = {
      jsonrpc: "2.0",
      id,
      result,
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
  }

  private sendError(id: any, code: number, message: string): void {
    const payload = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
  }
}

new MCPServer().start();
