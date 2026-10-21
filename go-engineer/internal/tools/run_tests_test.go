package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunGoTestsPassingAndDefaultPackage(t *testing.T) {
	project := writeTestProject(t, `package sample
import "testing"
func TestPass(t *testing.T) { t.Log("captured output") }`)
	result, err := RunGoTests(context.Background(), project, "")
	if err != nil || !result.Success || result.ExitCode != 0 || result.Package != "./..." || result.Truncated {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	if !strings.Contains(result.Output, "ok") {
		t.Errorf("output = %q, want go test output", result.Output)
	}
}

func TestRunGoTestsFailureIsStructured(t *testing.T) {
	project := writeTestProject(t, `package sample
import "testing"
func TestFail(t *testing.T) { t.Fatal("expected failure") }`)
	result, err := RunGoTests(context.Background(), project, "./...")
	if err != nil || result.Success || result.ExitCode == 0 || !strings.Contains(result.Output, "expected failure") {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
}

func TestRunGoTestsValidation(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ name, path, pattern, want string }{
		{"missing path", filepath.Join(t.TempDir(), "missing"), "./...", "does not exist"},
		{"missing mod", t.TempDir(), "./...", "go.mod not found"},
		{"file path", file, "./...", "not a directory"},
		{"unsafe pattern", t.TempDir(), "-run", "invalid Go package pattern"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := RunGoTests(context.Background(), test.path, test.pattern)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestRunGoTestsTruncatesOutput(t *testing.T) {
	project := writeTestProject(t, `package sample
import ("strings"; "testing")
func TestLongOutput(t *testing.T) { t.Error(strings.Repeat("x", 120000)) }`)
	result, err := RunGoTests(context.Background(), project, "./...")
	if err != nil || result.Success || !result.Truncated || len(result.Output) != maxTestOutput {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
}

func writeTestProject(t *testing.T, testSource string) string {
	t.Helper()
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/testproject\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "sample_test.go"), testSource)
	return project
}
