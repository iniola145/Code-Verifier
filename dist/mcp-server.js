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
const readline = __importStar(require("readline"));
const engine_1 = require("./engine");
const llm_formatter_1 = require("./formatter/llm-formatter");
/**
 * Lightweight JSON-RPC Model Context Protocol (MCP) Server
 * Exposes 'verify_code' tool to any LLM Agent via stdio.
 */
class MCPServer {
    verifier = new engine_1.CodeVerifier();
    start() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false,
        });
        rl.on('line', async (line) => {
            if (!line.trim())
                return;
            try {
                const message = JSON.parse(line);
                await this.handleMessage(message);
            }
            catch (err) {
                this.sendError(null, -32700, `Parse error: ${err.message}`);
            }
        });
    }
    async handleMessage(msg) {
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
                        description: 'Verifies React, React Native, and Expo TypeScript code using SAST and Abstract Interpretation. Checks for security leaks (AsyncStorage, secrets, XSS in WebViews), React Hook violations (infinite re-render loops, conditional hooks), and null dereferences.',
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
                    const outputText = format === 'json'
                        ? llm_formatter_1.LLMFormatter.formatJSON(result)
                        : llm_formatter_1.LLMFormatter.formatForLLMPrompt(result);
                    this.sendResponse(id, {
                        content: [
                            {
                                type: 'text',
                                text: outputText,
                            },
                        ],
                        isError: result.status !== 'PASSED',
                    });
                }
                catch (err) {
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
    sendResponse(id, result) {
        const payload = {
            jsonrpc: '2.0',
            id,
            result,
        };
        process.stdout.write(JSON.stringify(payload) + '\n');
    }
    sendError(id, code, message) {
        const payload = {
            jsonrpc: '2.0',
            id,
            error: { code, message },
        };
        process.stdout.write(JSON.stringify(payload) + '\n');
    }
}
new MCPServer().start();
