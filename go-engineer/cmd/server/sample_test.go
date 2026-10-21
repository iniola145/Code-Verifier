package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestSampleTodoAPIViaMCP(t *testing.T) {
	ctx := context.Background()
	server := newServer()

	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	go func() {
		_ = server.Run(ctx, serverTransport)
	}()

	client := mcp.NewClient(&mcp.Implementation{Name: "sample-tester", Version: "0.1.0"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client.Connect: %v", err)
	}
	defer session.Close()

	samplePath, err := filepath.Abs("../../samples/todo-api")
	if err != nil {
		t.Fatalf("resolve sample path: %v", err)
	}

	// 1. inspect_go_project
	inspectRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "inspect_go_project",
		Arguments: map[string]interface{}{"project_path": samplePath},
	})
	if err != nil || inspectRes.IsError {
		t.Fatalf("inspect_go_project failed: %v, %#v", err, inspectRes)
	}
	inspectText := inspectRes.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(inspectText, "example.com/todo-api") {
		t.Fatalf("expected module example.com/todo-api, got: %s", inspectText)
	}

	// 2. get_project_conventions
	convRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "get_project_conventions",
		Arguments: map[string]interface{}{"project_path": samplePath},
	})
	if err != nil || convRes.IsError {
		t.Fatalf("get_project_conventions failed: %v", err)
	}
	convText := convRes.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(convText, `"Architecture":"layered"`) {
		t.Fatalf("expected layered architecture in conventions, got: %s", convText)
	}

	// 3. find_go_symbol
	findRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "find_go_symbol",
		Arguments: map[string]interface{}{
			"project_path": samplePath,
			"symbol":       "GetTodo",
		},
	})
	if err != nil || findRes.IsError {
		t.Fatalf("find_go_symbol failed: %v", err)
	}
	findText := findRes.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(findText, "internal/handlers/todo.go") {
		t.Fatalf("expected symbol located in handlers/todo.go, got: %s", findText)
	}

	// 4. generate_go_test_scaffold
	scaffoldRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "generate_go_test_scaffold",
		Arguments: map[string]interface{}{
			"project_path": samplePath,
			"file_path":    "internal/handlers/todo.go",
			"symbol":       "GetTodo",
		},
	})
	if err != nil || scaffoldRes.IsError {
		t.Fatalf("generate_go_test_scaffold failed: %v", err)
	}
	scaffoldText := scaffoldRes.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(scaffoldText, "httptest.NewRecorder()") {
		t.Fatalf("expected httptest scaffold, got: %s", scaffoldText)
	}

	// 5. review_api_design (should detect SQL dynamic concatenation in repository)
	reviewRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "review_api_design",
		Arguments: map[string]interface{}{
			"project_path": samplePath,
			"package_path": "internal/repository",
		},
	})
	if err != nil || reviewRes.IsError {
		t.Fatalf("review_api_design failed: %v", err)
	}
	reviewText := reviewRes.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(reviewText, "sql-raw-concatenation") {
		t.Fatalf("expected sql-raw-concatenation finding, got: %s", reviewText)
	}

	// 6. run_go_tests
	testRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "run_go_tests",
		Arguments: map[string]interface{}{
			"project_path": samplePath,
			"package":      "./...",
		},
	})
	if err != nil || testRes.IsError {
		t.Fatalf("run_go_tests failed: %v", err)
	}
	testText := testRes.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(testText, `"success":true`) {
		t.Fatalf("expected tests to pass, got: %s", testText)
	}
}
