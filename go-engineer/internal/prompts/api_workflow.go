package prompts

import "fmt"

type GoAPIWorkflowArgs struct {
	ProjectPath string
	Task        string
}

func BuildGoAPIWorkflow(args GoAPIWorkflowArgs) string {
	return fmt.Sprintf(`You are working on a Go API repository.

Project: %s
Task: %s

Follow this evidence-first workflow. Do not skip directly to code generation while repository context is available.

1. Call inspect_go_project to learn the module, Go version, packages, dependencies, and tests. Do not assume a framework or architecture.
2. Call get_project_conventions. Treat explicit conventions as repository-specific. If missing or sparse, call suggest_project_config; treat suggestions as evidence, not truth, and never write .go-engineer.yaml automatically.
3. Identify the relevant package. If a symbol's file is unknown, call find_go_symbol; then call inspect_go_package, analyze_go_file only for likely files, and inspect_go_symbol for specific declarations whose implementation matters. Do not search or inspect every symbol unnecessarily.
4. Retrieve only relevant guideline resources. For HTTP work consider go://guidelines/api-design, handlers, services, error-handling, context, and testing. For concurrency consider go://guidelines/concurrency, context, and testing.
5. For HTTP/API packages call review_api_design. Treat findings as evidence, distinguish project-convention from general-guideline, and do not treat warnings as absolute architectural violations.
6. Before editing, identify affected files, functions/types, tests, and applicable conventions. Do not invent observed structure unnecessarily.
7. The external client may edit code. Follow existing patterns, preserve boundaries, propagate context, use existing error conventions, and add tests. The MCP server itself is read-only except for test execution.
8. Call run_go_tests, starting with a narrow package when useful and then ./... as appropriate. Test failures are implementation feedback, not MCP infrastructure failures; inspect output and iterate.

Do not request arbitrary shell commands, escape project paths, assume a specific architecture, or automatically modify project configuration.

Do not declare completion until relevant code and conventions were inspected, verification was run, and remaining failures are clearly reported.`, args.ProjectPath, args.Task)
}
