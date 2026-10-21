package main

import (
	"context"
	"log"
	"os"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go-engineer-mcp/internal/config"
	"go-engineer-mcp/internal/guidelines"
	"go-engineer-mcp/internal/prompts"
	"go-engineer-mcp/internal/tools"
)

type InspectProjectInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project to inspect"`
}

type RunGoTestsInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project"`
	Package     string `json:"package,omitempty" jsonschema:"Go package pattern to test"`
}

type AnalyzeGoFileInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project"`
	FilePath    string `json:"file_path" jsonschema:"Path to the Go source file relative to the project"`
}

type InspectGoPackageInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project"`
	PackagePath string `json:"package_path" jsonschema:"Go package path relative to the project"`
}

type ReviewAPIDesignInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project"`
	PackagePath string `json:"package_path" jsonschema:"Relative package containing the API or HTTP layer"`
}
type GetProjectConventionsInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project"`
}
type SuggestProjectConfigInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project"`
}
type InspectGoSymbolInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project"`
	FilePath    string `json:"file_path" jsonschema:"Path to the Go source file relative to the project"`
	Symbol      string `json:"symbol" jsonschema:"Go declaration name"`
	Receiver    string `json:"receiver,omitempty" jsonschema:"Optional method receiver type"`
}
type FindGoSymbolInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project"`
	Symbol      string `json:"symbol" jsonschema:"Exact Go declaration name"`
	Kind        string `json:"kind,omitempty" jsonschema:"Optional declaration kind"`
	Receiver    string `json:"receiver,omitempty" jsonschema:"Optional method receiver"`
	PackagePath string `json:"package_path,omitempty" jsonschema:"Optional relative package"`
}
type GenerateGoTestScaffoldInput struct {
	ProjectPath string `json:"project_path" jsonschema:"Path to the Go project"`
	FilePath    string `json:"file_path" jsonschema:"Relative path to the Go file"`
	Symbol      string `json:"symbol" jsonschema:"Name of the function or method to generate tests for"`
}
type ProjectConventionsOutput struct {
	Configured  bool                 `json:"configured"`
	File        string               `json:"file"`
	Version     int                  `json:"version"`
	Conventions config.ProjectConfig `json:"conventions"`
}

func main() {
	log.SetOutput(os.Stderr)

	server := newServer()

	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Printf("MCP server failed: %v", err)
		os.Exit(1)
	}
}

func newServer() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "go-engineer",
		Version: "0.1.0",
	}, nil)

	mcp.AddTool(server, &mcp.Tool{
		Name:         "inspect_go_project",
		Description:  "Inspect a Go project and return its module, package, file, test, and dependency information.",
		OutputSchema: inspectProjectOutputSchema(),
	}, inspectProjectHandler)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "run_go_tests",
		Description: "Run Go tests for a project or package and return structured test results.",
	}, runGoTestsHandler)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "analyze_go_file",
		Description: "Analyze a Go source file structurally using Go's parser and AST.",
	}, analyzeGoFileHandler)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "inspect_go_package",
		Description: "Inspect a Go package structurally, including its files, declarations, imports, and tests.",
	}, inspectGoPackageHandler)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "review_api_design",
		Description: "Review a Go HTTP/API package for structural API design and backend engineering concerns.",
	}, reviewAPIDesignHandler)
	mcp.AddTool(server, &mcp.Tool{Name: "get_project_conventions", Description: "Read optional project-specific Go engineering conventions."}, getProjectConventionsHandler)
	mcp.AddTool(server, &mcp.Tool{Name: "suggest_project_config", Description: "Inspect a Go project and suggest optional project-specific engineering conventions with supporting evidence."}, suggestProjectConfigHandler)
	mcp.AddTool(server, &mcp.Tool{Name: "inspect_go_symbol", Description: "Inspect one Go declaration from one source file for targeted implementation reasoning."}, inspectGoSymbolHandler)
	mcp.AddTool(server, &mcp.Tool{Name: "find_go_symbol", Description: "Search the repository for exact Go declaration names; returns locations only, not source or references."}, findGoSymbolHandler)
	mcp.AddTool(server, &mcp.Tool{Name: "generate_go_test_scaffold", Description: "Generate an idiomatic table-driven unit test or httptest scaffold for a Go function or HTTP handler."}, generateGoTestScaffoldHandler)
	for _, guideline := range guidelines.All() {
		item := guideline
		server.AddResource(&mcp.Resource{
			URI:         item.URI,
			Name:        item.Name,
			Description: item.Description,
			MIMEType:    "text/markdown",
		}, func(ctx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			_ = ctx
			found, ok := guidelines.Find(request.Params.URI)
			if !ok {
				return nil, mcp.ResourceNotFoundError(request.Params.URI)
			}
			return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: found.URI, MIMEType: "text/markdown", Text: found.Content}}}, nil
		})
		_ = item
	}
	server.AddPrompt(&mcp.Prompt{Name: "go_api_engineering_workflow", Description: "Guide an LLM through reliable Go API repository understanding, implementation, and verification.", Arguments: []*mcp.PromptArgument{{Name: "project_path", Description: "Path to the Go project", Required: true}, {Name: "task", Description: "The Go API engineering task", Required: true}}}, func(ctx context.Context, request *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		_ = ctx
		args := request.Params.Arguments
		return &mcp.GetPromptResult{Description: "Evidence-first Go API engineering workflow", Messages: []*mcp.PromptMessage{{Role: mcp.Role("user"), Content: &mcp.TextContent{Text: prompts.BuildGoAPIWorkflow(prompts.GoAPIWorkflowArgs{ProjectPath: args["project_path"], Task: args["task"]})}}}}, nil
	})

	return server
}
func findGoSymbolHandler(ctx context.Context, _ *mcp.CallToolRequest, input FindGoSymbolInput) (*mcp.CallToolResult, tools.SymbolSearchResult, error) {
	result, err := tools.FindGoSymbol(ctx, input.ProjectPath, input.Symbol, input.Kind, input.Receiver, input.PackagePath)
	if err != nil {
		return nil, tools.SymbolSearchResult{}, err
	}
	return nil, result, nil
}

func generateGoTestScaffoldHandler(ctx context.Context, _ *mcp.CallToolRequest, input GenerateGoTestScaffoldInput) (*mcp.CallToolResult, tools.TestScaffoldResult, error) {
	result, err := tools.GenerateGoTestScaffold(ctx, input.ProjectPath, input.FilePath, input.Symbol)
	if err != nil {
		return nil, tools.TestScaffoldResult{}, err
	}
	return nil, result, nil
}

func inspectGoSymbolHandler(ctx context.Context, _ *mcp.CallToolRequest, input InspectGoSymbolInput) (*mcp.CallToolResult, tools.GoSymbolInfo, error) {
	result, err := tools.InspectGoSymbol(ctx, input.ProjectPath, input.FilePath, input.Symbol, input.Receiver)
	if err != nil {
		return nil, tools.GoSymbolInfo{}, err
	}
	return nil, result, nil
}

func suggestProjectConfigHandler(ctx context.Context, _ *mcp.CallToolRequest, input SuggestProjectConfigInput) (*mcp.CallToolResult, tools.ProjectConfigSuggestion, error) {
	result, err := tools.SuggestProjectConfig(ctx, input.ProjectPath)
	if err != nil {
		return nil, tools.ProjectConfigSuggestion{}, err
	}
	return nil, result, nil
}

func getProjectConventionsHandler(_ context.Context, _ *mcp.CallToolRequest, input GetProjectConventionsInput) (*mcp.CallToolResult, ProjectConventionsOutput, error) {
	cfg, found, err := config.LoadProjectConfigIfExists(input.ProjectPath)
	if err != nil {
		return nil, ProjectConventionsOutput{}, err
	}
	return nil, ProjectConventionsOutput{Configured: found, File: ".go-engineer.yaml", Version: cfg.Version, Conventions: cfg}, nil
}

func reviewAPIDesignHandler(ctx context.Context, _ *mcp.CallToolRequest, input ReviewAPIDesignInput) (*mcp.CallToolResult, tools.APIReview, error) {
	review, err := tools.ReviewAPIDesign(ctx, input.ProjectPath, input.PackagePath)
	if err != nil {
		return nil, tools.APIReview{}, err
	}
	return nil, review, nil
}

func inspectGoPackageHandler(ctx context.Context, _ *mcp.CallToolRequest, input InspectGoPackageInput) (*mcp.CallToolResult, tools.GoPackageInfo, error) {
	info, err := tools.InspectGoPackage(ctx, input.ProjectPath, input.PackagePath)
	if err != nil {
		return nil, tools.GoPackageInfo{}, err
	}
	return nil, info, nil
}

func analyzeGoFileHandler(ctx context.Context, _ *mcp.CallToolRequest, input AnalyzeGoFileInput) (*mcp.CallToolResult, tools.GoFileInfo, error) {
	info, err := tools.AnalyzeGoFile(ctx, input.ProjectPath, input.FilePath)
	if err != nil {
		return nil, tools.GoFileInfo{}, err
	}
	return nil, info, nil
}

func runGoTestsHandler(ctx context.Context, _ *mcp.CallToolRequest, input RunGoTestsInput) (*mcp.CallToolResult, tools.GoTestResult, error) {
	result, err := tools.RunGoTests(ctx, input.ProjectPath, input.Package)
	if err != nil {
		return nil, tools.GoTestResult{}, err
	}
	return nil, result, nil
}

func inspectProjectOutputSchema() *jsonschema.Schema {
	stringArray := func() *jsonschema.Schema {
		return &jsonschema.Schema{
			Type:  "array",
			Items: &jsonschema.Schema{Type: "string"},
		}
	}
	return &jsonschema.Schema{
		Type: "object",
		Properties: map[string]*jsonschema.Schema{
			"module":       {Type: "string"},
			"go_version":   {Type: "string"},
			"directories":  stringArray(),
			"packages":     stringArray(),
			"go_files":     {Type: "integer"},
			"test_files":   {Type: "integer"},
			"has_tests":    {Type: "boolean"},
			"dependencies": stringArray(),
		},
		Required: []string{
			"module", "go_version", "directories", "packages",
			"go_files", "test_files", "has_tests", "dependencies",
		},
	}
}

func inspectProjectHandler(ctx context.Context, _ *mcp.CallToolRequest, input InspectProjectInput) (*mcp.CallToolResult, tools.GoProjectInfo, error) {
	info, err := tools.InspectGoProject(ctx, input.ProjectPath)
	if err != nil {
		return nil, tools.GoProjectInfo{}, err
	}
	return nil, info, nil
}
