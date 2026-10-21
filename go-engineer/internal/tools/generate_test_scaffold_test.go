package tools

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateGoTestScaffold(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/scaffold\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "handlers.go"), `package api

import "net/http"

type UserHandler struct{}

func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusCreated)
}

func CalculateTax(amount float64) (float64, error) {
	return amount * 0.1, nil
}
`)

	// Test 1: HTTP Handler Method
	httpResult, err := GenerateGoTestScaffold(context.Background(), project, "handlers.go", "CreateUser")
	if err != nil {
		t.Fatalf("GenerateGoTestScaffold(CreateUser): %v", err)
	}
	if !httpResult.IsHTTP {
		t.Errorf("expected IsHTTP = true")
	}
	if httpResult.Target != "CreateUser" || httpResult.Receiver != "*UserHandler" {
		t.Errorf("unexpected target/receiver: %v / %v", httpResult.Target, httpResult.Receiver)
	}
	if !strings.Contains(httpResult.TestCode, "httptest.NewRecorder()") {
		t.Errorf("expected httptest recorder in test code, got:\n%s", httpResult.TestCode)
	}

	// Test 2: Regular Function
	funcResult, err := GenerateGoTestScaffold(context.Background(), project, "handlers.go", "CalculateTax")
	if err != nil {
		t.Fatalf("GenerateGoTestScaffold(CalculateTax): %v", err)
	}
	if funcResult.IsHTTP {
		t.Errorf("expected IsHTTP = false")
	}
	if !strings.Contains(funcResult.TestCode, "CalculateTax") {
		t.Errorf("expected function call in scaffold")
	}

	// Test 3: Missing function
	_, err = GenerateGoTestScaffold(context.Background(), project, "handlers.go", "NonExistent")
	if err == nil {
		t.Errorf("expected error for non-existent function, got nil")
	}
}

