# Go API engineering workflow

The `go_api_engineering_workflow` MCP prompt guides an external model through repository inspection, convention discovery, targeted AST analysis, guideline retrieval, API review, implementation, and test verification.

For a task such as `Add POST /users`, provide the project path and task to the prompt. The expected sequence begins with `inspect_go_project`, then `get_project_conventions`, optional `suggest_project_config`, locating symbols with `find_go_symbol`, targeted inspection with `inspect_go_package`, `analyze_go_file`, and `inspect_go_symbol`, relevant guidelines, `review_api_design`, code changes by the client, and `run_go_tests`.

The prompt treats project conventions as repository-specific and suggestions as non-authoritative. It does not write `.go-engineer.yaml`; the server remains read-only apart from running tests.
