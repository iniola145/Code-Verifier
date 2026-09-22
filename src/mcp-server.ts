import * as readline from 'readline';
import { CodeVerifier } from './engine';
import { LLMFormatter } from './formatter/llm-formatter';

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

    rl.on('line', async (line) => {
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

    if (method === 'initialize') {
      this.sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'code-verifier-mcp',
          version: '1.0.0',
        },
      });
      return;
    }

    if (method === 'tools/list') {
      this.sendResponse(id, {
        tools: [
          {
            name: 'verify_code',
            description:
              'Verifies React, React Native, and Expo TypeScript code using SAST and Abstract Interpretation. Checks for security leaks (AsyncStorage, secrets, XSS in WebViews), React Hook violations (infinite re-render loops, conditional hooks), and null dereferences.',
            inputSchema: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description: 'The TypeScript/TSX/JSX source code to verify',
                },
                filePath: {
                  type: 'string',
                  description: 'Optional filename (e.g. App.tsx, ProfileScreen.tsx)',
                  default: 'Component.tsx',
                },
                format: {
                  type: 'string',
                  enum: ['llm', 'json'],
                  description: 'Format of diagnostic output (llm prompt markdown or raw json)',
                  default: 'llm',
                },
              },
              required: ['code'],
            },
          },
        ],
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === 'verify_code') {
        const code = args.code;
        const filePath = args.filePath || 'Component.tsx';
        const format = args.format || 'llm';

        try {
          const result = await this.verifier.verifyCode(code, filePath);
          const outputText =
            format === 'json'
              ? LLMFormatter.formatJSON(result)
              : LLMFormatter.formatForLLMPrompt(result);

          this.sendResponse(id, {
            content: [
              {
                type: 'text',
                text: outputText,
              },
            ],
            isError: result.status !== 'PASSED',
          });
        } catch (err: any) {
          this.sendResponse(id, {
            content: [
              {
                type: 'text',
                text: `Error verifying code: ${err.message}`,
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

    if (method === 'ping') {
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
      jsonrpc: '2.0',
      id,
      result,
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
  }

  private sendError(id: any, code: number, message: string): void {
    const payload = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
  }
}

new MCPServer().start();
