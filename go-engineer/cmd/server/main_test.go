package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestServerE2E(t *testing.T) {
	ctx := context.Background()
	server := newServer()

	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	go func() {
		_ = server.Run(ctx, serverTransport)
	}()

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "0.1.0"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client.Connect: %v", err)
	}
	defer session.Close()

	// 1. Verify Tools
	toolsResult, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}

	expectedTools := []string{
		"inspect_go_project",
		"run_go_tests",
		"analyze_go_file",
		"inspect_go_package",
		"review_api_design",
		"get_project_conventions",
		"suggest_project_config",
		"inspect_go_symbol",
		"find_go_symbol",
	}

	toolMap := make(map[string]bool)
	for _, tool := range toolsResult.Tools {
		toolMap[tool.Name] = true
	}

	for _, name := range expectedTools {
		if !toolMap[name] {
			t.Errorf("missing expected tool: %s", name)
		}
	}
	if len(toolsResult.Tools) != len(expectedTools) {
		t.Errorf("got %d tools, want %d", len(toolsResult.Tools), len(expectedTools))
	}

	// 2. Test Tool Calling (get_project_conventions on empty directory)
	tempDir := t.TempDir()
	convCall, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "get_project_conventions",
		Arguments: map[string]interface{}{
			"project_path": tempDir,
		},
	})
	if err != nil {
		t.Fatalf("CallTool get_project_conventions: %v", err)
	}
	if convCall.IsError {
		t.Fatalf("get_project_conventions returned tool error: %#v", convCall)
	}

	// 3. Verify Resources
	resourcesResult, err := session.ListResources(ctx, nil)
	if err != nil {
		t.Fatalf("ListResources: %v", err)
	}

	expectedResources := []string{
		"go://guidelines/api-design",
		"go://guidelines/handlers",
		"go://guidelines/services",
		"go://guidelines/error-handling",
		"go://guidelines/testing",
		"go://guidelines/context",
		"go://guidelines/concurrency",
	}

	resourceMap := make(map[string]bool)
	for _, res := range resourcesResult.Resources {
		resourceMap[res.URI] = true
	}

	for _, uri := range expectedResources {
		if !resourceMap[uri] {
			t.Errorf("missing expected resource: %s", uri)
		}
		// Read each resource
		readRes, err := session.ReadResource(ctx, &mcp.ReadResourceParams{
			URI: uri,
		})
		if err != nil {
			t.Errorf("ReadResource(%s): %v", uri, err)
			continue
		}
		if len(readRes.Contents) == 0 || readRes.Contents[0].Text == "" {
			t.Errorf("empty resource contents for %s", uri)
		}
	}

	// Unknown resource should return error
	_, err = session.ReadResource(ctx, &mcp.ReadResourceParams{
		URI: "go://guidelines/non-existent",
	})
	if err == nil {
		t.Errorf("expected error for non-existent resource, got nil")
	}

	// 4. Verify Prompts
	promptsResult, err := session.ListPrompts(ctx, nil)
	if err != nil {
		t.Fatalf("ListPrompts: %v", err)
	}
	if len(promptsResult.Prompts) != 1 || promptsResult.Prompts[0].Name != "go_api_engineering_workflow" {
		t.Fatalf("unexpected prompts list: %#v", promptsResult.Prompts)
	}

	promptRes, err := session.GetPrompt(ctx, &mcp.GetPromptParams{
		Name: "go_api_engineering_workflow",
		Arguments: map[string]string{
			"project_path": tempDir,
			"task":         "Add endpoint",
		},
	})
	if err != nil {
		t.Fatalf("GetPrompt: %v", err)
	}
	if len(promptRes.Messages) == 0 {
		t.Fatalf("empty messages in GetPrompt result")
	}
	textMsg, ok := promptRes.Messages[0].Content.(*mcp.TextContent)
	if !ok || !strings.Contains(textMsg.Text, "inspect_go_project") {
		t.Fatalf("unexpected prompt message content: %#v", promptRes.Messages[0].Content)
	}

	// 5. Test inspecting a sample Go project via CallTool
	manifestFile := filepath.Join(tempDir, "go.mod")
	if err := os.WriteFile(manifestFile, []byte("module example.com/testmod\n\ngo 1.23\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "main.go"), []byte("package main\nfunc main() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}

	inspectCall, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "inspect_go_project",
		Arguments: map[string]interface{}{
			"project_path": tempDir,
		},
	})
	if err != nil {
		t.Fatalf("CallTool inspect_go_project: %v", err)
	}
	if inspectCall.IsError {
		t.Fatalf("inspect_go_project returned tool error: %#v", inspectCall)
	}
}

