import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

export interface GoToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class GoBridge {
  private static binaryPath: string | null = null;

  public static getBinaryPath(): string {
    if (this.binaryPath) {
      return this.binaryPath;
    }

    const isWindows = process.platform === "win32";
    const binaryName = isWindows ? "go-engineer.exe" : "go-engineer";

    // 1. Check local go-engineer/bin in repo
    const candidatePath = path.resolve(__dirname, "../../go-engineer/bin", binaryName);
    if (fs.existsSync(candidatePath)) {
      this.binaryPath = candidatePath;
      return candidatePath;
    }

    // 2. Fallback to go-engineer directory
    const fallbackPath = path.resolve(__dirname, "../go-engineer/bin", binaryName);
    if (fs.existsSync(fallbackPath)) {
      this.binaryPath = fallbackPath;
      return fallbackPath;
    }

    return binaryName;
  }

  public static isGoTool(toolName: string): boolean {
    return [
      "inspect_go_project",
      "run_go_tests",
      "analyze_go_file",
      "inspect_go_package",
      "review_api_design",
      "get_project_conventions",
      "suggest_project_config",
      "inspect_go_symbol",
      "find_go_symbol",
      "generate_go_test_scaffold",
    ].includes(toolName);
  }

  public static getGoToolDefinitions() {
    return [
      {
        name: "inspect_go_project",
        description: "Inspect a Go project and return its module, package, file, test, and dependency information.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
          },
          required: ["project_path"],
        },
      },
      {
        name: "run_go_tests",
        description: "Run Go tests for a project or package and return structured test results.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
            package: { type: "string", description: "Go package pattern (default ./...)" },
          },
          required: ["project_path"],
        },
      },
      {
        name: "analyze_go_file",
        description: "Analyze a Go source file structurally using Go's parser and AST.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
            file_path: { type: "string", description: "Relative path to Go file" },
          },
          required: ["project_path", "file_path"],
        },
      },
      {
        name: "inspect_go_package",
        description: "Inspect a Go package structurally, including files, declarations, imports, and tests.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
            package_path: { type: "string", description: "Relative package path" },
          },
          required: ["project_path", "package_path"],
        },
      },
      {
        name: "review_api_design",
        description: "Review a Go HTTP/API package for structural API design, boundary, resource leak, and SQL security concerns.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
            package_path: { type: "string", description: "Relative package containing the API or HTTP layer" },
          },
          required: ["project_path", "package_path"],
        },
      },
      {
        name: "get_project_conventions",
        description: "Read optional project-specific Go engineering conventions (.go-engineer.yaml).",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
          },
          required: ["project_path"],
        },
      },
      {
        name: "suggest_project_config",
        description: "Inspect a Go project and suggest optional project-specific engineering conventions with supporting evidence.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
          },
          required: ["project_path"],
        },
      },
      {
        name: "inspect_go_symbol",
        description: "Inspect one Go declaration from one source file for targeted implementation reasoning.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
            file_path: { type: "string", description: "Relative path to Go file" },
            symbol: { type: "string", description: "Go declaration name" },
            receiver: { type: "string", description: "Optional method receiver type" },
          },
          required: ["project_path", "file_path", "symbol"],
        },
      },
      {
        name: "find_go_symbol",
        description: "Search the repository for exact Go declaration names across functions, types, constants, and variables.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
            symbol: { type: "string", description: "Exact declaration name" },
            kind: { type: "string", description: "Optional declaration kind" },
            receiver: { type: "string", description: "Optional receiver type" },
            package_path: { type: "string", description: "Optional package path" },
          },
          required: ["project_path", "symbol"],
        },
      },
      {
        name: "generate_go_test_scaffold",
        description: "Synthesize an idiomatic table-driven unit test or httptest scaffold for a Go function or HTTP handler.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Path to the Go project" },
            file_path: { type: "string", description: "Relative path to Go source file" },
            symbol: { type: "string", description: "Name of function or method to generate tests for" },
          },
          required: ["project_path", "file_path", "symbol"],
        },
      },
    ];
  }

  public static async executeGoTool(toolName: string, args: any): Promise<GoToolCallResult> {
    const binPath = this.getBinaryPath();

    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(binPath, [], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err: any) {
        return resolve({
          content: [{ type: "text", text: `Failed to spawn go-engineer server binary at ${binPath}: ${err.message}` }],
          isError: true,
        });
      }

      let stdoutData = "";
      let stderrData = "";
      let resolved = false;

      proc.stdout?.on("data", (chunk) => {
        stdoutData += chunk.toString();
        const lines = stdoutData.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === 1) {
              // initialize response, now send tools/call
              const callMsg = {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                  name: toolName,
                  arguments: args,
                },
              };
              proc.stdin?.write(JSON.stringify(callMsg) + "\n");
            } else if (parsed.id === 2) {
              resolved = true;
              proc.kill();
              if (parsed.error) {
                return resolve({
                  content: [{ type: "text", text: `Go Tool Error: ${parsed.error.message}` }],
                  isError: true,
                });
              }
              return resolve({
                content: parsed.result?.content || [
                  { type: "text", text: JSON.stringify(parsed.result, null, 2) },
                ],
                isError: parsed.result?.isError || false,
              });
            }
          } catch {
            // ignore non-json or incomplete chunks
          }
        }
        stdoutData = lines[lines.length - 1];
      });

      proc.stderr?.on("data", (chunk) => {
        stderrData += chunk.toString();
      });

      proc.on("error", (err) => {
        if (!resolved) {
          resolve({
            content: [{ type: "text", text: `Go Tool execution error: ${err.message}. Stderr: ${stderrData}` }],
            isError: true,
          });
        }
      });

      proc.on("close", (code) => {
        if (!resolved) {
          resolve({
            content: [{ type: "text", text: `Go process terminated with code ${code}. Stderr: ${stderrData}` }],
            isError: true,
          });
        }
      });

      // Send initial MCP initialize handshake
      const initMsg = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "code-verifier-bridge", version: "1.0.0" },
        },
      };

      proc.stdin?.write(JSON.stringify(initMsg) + "\n");
    });
  }
}
