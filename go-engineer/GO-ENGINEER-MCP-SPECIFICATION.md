# go-engineer-mcp — Current Implementation Specification

Status: working incremental vertical slice. Go module: go-engineer-mcp. MCP server identity: go-engineer v0.1.0. Transport: stdio. SDK: github.com/modelcontextprotocol/go-sdk v1.8.0.

## Purpose

This server improves an external LLM's ability to work on Go backend repositories. It provides repository facts, structural AST inspection, bounded Go test execution, API review findings, optional repository conventions, reusable engineering guidance, and a workflow prompt. It does not contain an LLM or generate arbitrary Go code. The external client/model performs reasoning and editing.

## Architecture

```text
MCP client / LLM
      |
cmd/server (MCP tools, resources, prompt)
      |
internal/tools ---- filesystem, go.mod, go list, go test
internal/config --- optional .go-engineer.yaml
internal/guidelines - Markdown guidance
internal/prompts --- workflow text
```

The MCP SDK is kept out of internal/tools, internal/config, internal/guidelines, and internal/prompts wherever practical. Inspection is read-only; test execution is the only operation that launches a repository command.

## Tools

### inspect_go_project

Input: project_path. Validates existence, directory status, and go.mod. It reads module and Go version using go mod edit -json, packages using go list -buildvcs=false -json ./..., and counts files with filesystem APIs. Output includes module, Go version, top-level directories, packages, Go/test file counts, HasTests, and direct dependencies. Collection fields are normalized to empty arrays rather than JSON null.

### run_go_tests

Input: project_path and optional package, defaulting to ./.... It invokes go directly with exec.CommandContext and sets the project as working directory. Package input rejects flags, whitespace, and shell separators. Combined stdout/stderr is capped at 100 KB and reports truncation. A failed test assertion returns a structured GoTestResult with Success false and an exit code; invalid paths, cancellation, and process-start failures return errors.

### analyze_go_file

Input: project_path and a relative file_path. Absolute paths, traversal, missing files, directories, and non-Go files are rejected. The path is checked against the project boundary. go/parser, go/ast, go/token, and go/format render package/import/function/method/struct/interface/type/constant/variable information without returning the complete source.

### inspect_go_package

Input: project_path and relative package_path. Only immediate Go files are inspected; subdirectories are not included. Production and test files are separated, imports are merged/deduplicated/sorted, and external test packages such as tools_test are accepted. Inconsistent production package declarations are rejected. Exported metadata uses ast.IsExported. Build tags are parsed but not fully evaluated for the current platform.

### review_api_design

Produces evidence-based findings, not a quality score. Current stable rules are:

- handler-direct-db
- service-http-dependency
- context-background-with-existing-context
- panic-request-path
- error-string-classification
- rpc-style-route

It detects likely HTTP handlers through http.ResponseWriter and *http.Request signatures, uses conservative service/application path signals, requires database/sql evidence for direct database findings, and only recognizes limited literal router patterns. Findings contain rule, category, severity, location, description, evidence, and guideline URI; some include source values general-guideline or project-convention. Findings are deterministically sorted.

### get_project_conventions

Reads only project-root/.go-engineer.yaml. It reports configured, relative filename, version, and typed conventions. It never writes configuration.

### suggest_project_config

Scans and parses repository Go files, excluding .git, bin, vendor, and .test-gocache. It suggests version 1, supported routers (chi, gin, echo, stdlib), package roles, layered architecture only when handler/service/repository boundaries are present, and testing.default_package ./.... Each suggestion has high/medium/low confidence and concise reasons. It reports existing configuration and never overwrites it. Unsupported or weakly evidenced architecture and conventions are left unspecified.

### find_go_symbol

Input: project_path, symbol, and optional kind, receiver, package_path. Traversal outside the repository or non-existent package directories are rejected. It walks repository Go source files, skipping .git, vendor, bin, and .test-gocache. Matches are filtered by exact declaration name, kind (function, method, struct, interface, type, const, var), and receiver. Up to 200 matches are returned, deterministically sorted by package path, file, start line, kind, and receiver. When matches exceed 200, the result reports truncation. Parser warnings are collected for unparseable files without aborting the scan.

### inspect_go_symbol

Input: project_path, relative file_path, symbol, and optional receiver. Absolute paths, directory traversal, non-existent files, and non-Go files are rejected. go/parser and go/ast find the exact declaration in the file. Ambiguous declarations (such as multiple methods with differing receivers) require specifying receiver. Source snippets are extracted and formatted using go/format, capped at 100 KB with truncation reporting. Output includes relative file path, package name, kind, line numbers, exported status, and formatted source.

## Project configuration

Configuration is optional and repository-specific. Existing files must declare version: 1. Version 0 is reserved internally for no configuration loaded; missing, zero, and future versions in a file are rejected. YAML uses gopkg.in/yaml.v3 with strict known-field decoding.

The typed schema contains project architecture, HTTP router, handler/service/repository package paths, database direct-access convention, error classification, context propagation, and testing default package. Optional booleans use *bool: nil means unspecified, pointer false means explicitly false, and pointer true means explicitly true. Relative package paths cannot be empty, absolute, or escaping through .. .

Project conventions specialize general guidance; they are not universal Go best practices. A missing file leaves configured=false and internal version 0.

## Resources

The server exposes these Markdown resources:

- go://guidelines/api-design
- go://guidelines/handlers
- go://guidelines/services
- go://guidelines/error-handling
- go://guidelines/testing
- go://guidelines/context
- go://guidelines/concurrency

Content is concise, project-independent guidance. It does not assume chi, Gin, Echo, PostgreSQL, repositories, or Clean Architecture.

## Prompt

The prompt go_api_engineering_workflow accepts project_path and task. It guides an external LLM through project inspection, convention discovery, optional suggestion, targeted package/file inspection, relevant guideline retrieval, API review, external editing, run_go_tests, and iteration. It explicitly says not to skip repository context, treat heuristics as evidence, avoid arbitrary shell commands, and never automatically modify .go-engineer.yaml.

## Verification

```bash
go test ./...
go vet ./...
go build -buildvcs=false -o bin/go-engineer.exe ./cmd/server
```

The executable remains in bin/go-engineer.exe. The build flag avoids failures when usable Git metadata is unavailable for Go VCS stamping.

## Package layout

```text
cmd/server/{main.go,main_test.go}
internal/config/{config.go,config_test.go}
internal/guidelines/{guidelines.go,guidelines_test.go}
internal/prompts/{api_workflow.go,api_workflow_test.go}
internal/tools/{analyze_file.go,analyze_file_test.go,find_symbol.go,find_symbol_test.go,inspect_package.go,inspect_package_test.go,inspect_project.go,inspect_project_test.go,inspect_symbol.go,inspect_symbol_test.go,review_api.go,review_api_test.go,run_tests.go,run_tests_test.go,suggest_config.go,suggest_config_test.go}
PROJECT-CONFIGURATION.md
README.md
WORKFLOW.md
```

## Explicit non-goals

No embedded LLM, arbitrary shell tool, code rewriting, automatic configuration writing, HTTP MCP transport, authentication, Docker, database infrastructure, full semantic type checking, repository-wide indexing, complete router support, security scanning, performance analysis, architecture scoring, go vet tool, formatter tool, or API auto-fix tool is implemented.

