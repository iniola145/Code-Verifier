# go-engineer-mcp

`go-engineer-mcp` is an evidence-first [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server designed to assist external Large Language Models (LLMs) when working on Go backend repositories.

It inspects Go modules, files, packages, and declarations via AST parsing, runs bounded tests, surfaces architectural and API review findings, discovers project-specific conventions, and provides reusable engineering guidelines.

### Design Philosophy

- **No Embedded LLM**: The server does not invoke an LLM internally or generate arbitrary code. The client/model performs reasoning and editing.
- **Evidence-First**: Inspection tools return facts (module info, syntax trees, declarations, error classifications), not speculative advice or arbitrary quality scores.
- **Read-Only Safety**: All inspection operations and resources are strictly read-only and never write or alter source or configuration files. The only tool that executes repository processes is `run_go_tests`, which is bounded with argument validation and output truncation.
- **Stdio Transport**: Built using the official [`github.com/modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk) v1.8.0.

---

### Features & Capabilities

#### 1. MCP Tools (10)

| Tool | Description |
|---|---|
| `inspect_go_project` | Reads `go.mod`, lists packages, detects dependencies, and counts Go/test files. |
| `run_go_tests` | Executes bounded `go test` with package pattern validation and output size limits. |
| `analyze_go_file` | Parses AST to extract imports, types, structs, interfaces, functions, and variables. |
| `inspect_go_package` | Analyzes immediate package files, separating production and test code. |
| `review_api_design` | Evaluates HTTP/API packages against structural rules (handler DB leaks, context roots, panics, RPC routes, SQL injection, HTTP body leaks). |
| `get_project_conventions` | Reads optional `.go-engineer.yaml` project conventions (architecture, router, layer packages). |
| `suggest_project_config` | Scans imports and directory patterns to heuristically suggest conventions with confidence levels. |
| `inspect_go_symbol` | Locates and extracts formatted source and line numbers for a specific Go declaration. |
| `find_go_symbol` | Searches the repository for exact Go symbol names across functions, types, constants, and variables. |
| `generate_go_test_scaffold` | Synthesizes an idiomatic table-driven unit test or `httptest` scaffold for any function or handler. |

#### 2. Guideline Resources (7)

Markdown guidance accessible via standard MCP resource URIs:
- `go://guidelines/api-design`: Resource-oriented routing, status codes, and HTTP semantics.
- `go://guidelines/handlers`: Request decoding, boundary validation, and domain mapping.
- `go://guidelines/services`: Business rules, transaction boundaries, and interface sizing.
- `go://guidelines/error-handling`: Wrapping with `%w`, sentinel check with `errors.Is`/`errors.As`.
- `go://guidelines/testing`: Deterministic tests, table-driven structure, and fakes.
- `go://guidelines/context`: Context propagation, deadline respect, and cancellation.
- `go://guidelines/concurrency`: Goroutine lifecycles, race prevention, channels, and sync primitives.

#### 3. Workflow Prompt (1)

- `go_api_engineering_workflow`: Guides an LLM through evidence gathering, convention discovery, package inspection, guideline review, client editing, test execution, and verification.

---

### Installation & Build

Requires Go 1.23+.

```bash
# Run tests
go test ./...

# Run vet
go vet ./...

# Build binary
go build -buildvcs=false -o bin/go-engineer.exe ./cmd/server
```

---

### MCP Client Configuration

Add `go-engineer` to your MCP client configuration (such as Claude Desktop, Cursor, or Antigravity):

```json
{
  "mcpServers": {
    "go-engineer": {
      "command": "path/to/go-engineer-mcp/bin/go-engineer.exe"
    }
  }
}
```

---

### Documentation Links

- [GO-ENGINEER-MCP-SPECIFICATION.md](GO-ENGINEER-MCP-SPECIFICATION.md) — Complete technical specification and architectural rules.
- [PROJECT-CONFIGURATION.md](PROJECT-CONFIGURATION.md) — Schema and semantics for optional `.go-engineer.yaml` files.
- [WORKFLOW.md](WORKFLOW.md) — Recommended sequence of tool and resource invocations.

