package tools

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestInspectGoProject(t *testing.T) {
	projectPath := writeProject(t)

	info, err := InspectGoProject(context.Background(), projectPath)
	if err != nil {
		t.Fatalf("InspectGoProject() error = %v", err)
	}

	if info.Module != "example.com/my-api" {
		t.Errorf("Module = %q, want %q", info.Module, "example.com/my-api")
	}
	if info.GoVersion != "1.23" {
		t.Errorf("GoVersion = %q, want %q", info.GoVersion, "1.23")
	}
	if want := []string{"github.com/example/direct"}; !reflect.DeepEqual(info.Dependencies, want) {
		t.Errorf("Dependencies = %v, want %v", info.Dependencies, want)
	}
	if info.GoFiles != 5 {
		t.Errorf("GoFiles = %d, want 5", info.GoFiles)
	}
	if info.TestFiles != 1 {
		t.Errorf("TestFiles = %d, want 1", info.TestFiles)
	}
	if !info.HasTests {
		t.Error("HasTests = false, want true")
	}
	if want := []string{"cmd", "internal"}; !reflect.DeepEqual(info.Directories, want) {
		t.Errorf("Directories = %v, want %v", info.Directories, want)
	}
	if want := []string{"example.com/my-api", "example.com/my-api/cmd/api", "example.com/my-api/internal/service"}; !reflect.DeepEqual(info.Packages, want) {
		t.Errorf("Packages = %v, want %v", info.Packages, want)
	}
}

func TestInspectGoProjectInvalidPaths(t *testing.T) {
	tests := []struct {
		name    string
		path    func(t *testing.T) string
		message string
	}{
		{"nonexistent path", func(t *testing.T) string { return filepath.Join(t.TempDir(), "missing") }, "does not exist"},
		{"file path", func(t *testing.T) string {
			path := filepath.Join(t.TempDir(), "project.txt")
			writeFile(t, path, "content")
			return path
		}, "not a directory"},
		{"missing go.mod", func(t *testing.T) string { return t.TempDir() }, "go.mod not found"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := InspectGoProject(context.Background(), tt.path(t))
			if err == nil || !containsError(err, tt.message) {
				t.Fatalf("error = %v, want message containing %q", err, tt.message)
			}
		})
	}
}

func TestInspectGoProjectEmptyPath(t *testing.T) {
	_, err := InspectGoProject(context.Background(), " ")
	if err == nil || !containsError(err, "path is required") {
		t.Fatalf("error = %v, want required-path error", err)
	}
}

func TestReadModuleInfo(t *testing.T) {
	projectPath := writeProject(t)
	got, err := readModuleInfo(context.Background(), projectPath)
	if err != nil {
		t.Fatalf("readModuleInfo() error = %v", err)
	}
	if got.Module != "example.com/my-api" || got.GoVersion != "1.23" {
		t.Errorf("module info = %#v, want module and Go version", got)
	}
}

func TestScanFiles(t *testing.T) {
	projectPath := writeProject(t)
	// Write ignored files inside directories that scanFiles should skip
	writeFile(t, filepath.Join(projectPath, ".git", "ignored.go"), "package ignored\n")
	writeFile(t, filepath.Join(projectPath, "vendor", "dep", "dep.go"), "package dep\n")
	writeFile(t, filepath.Join(projectPath, "bin", "tool.go"), "package tool\n")
	writeFile(t, filepath.Join(projectPath, ".test-gocache", "cached.go"), "package cached\n")

	directories, goFiles, testFiles, err := scanFiles(projectPath)
	if err != nil {
		t.Fatalf("scanFiles() error = %v", err)
	}
	if !reflect.DeepEqual(directories, []string{"cmd", "internal"}) || goFiles != 5 || testFiles != 1 {
		t.Errorf("scanFiles() = (%v, %d, %d), want ([cmd internal], 5, 1)", directories, goFiles, testFiles)
	}
}

func TestNormalizeProjectInfoUsesEmptySlices(t *testing.T) {
	info := GoProjectInfo{}
	normalizeProjectInfo(&info)

	if info.Directories == nil || info.Packages == nil || info.Dependencies == nil {
		t.Fatal("normalized collection fields must be non-nil")
	}
}

func writeProject(t *testing.T) string {
	t.Helper()
	projectPath := t.TempDir()
	dependencyPath := t.TempDir()
	writeFile(t, filepath.Join(dependencyPath, "go.mod"), "module github.com/example/direct\n\ngo 1.23\n")
	writeFile(t, filepath.Join(dependencyPath, "direct.go"), "package direct\n")
	writeFile(t, filepath.Join(projectPath, "go.mod"), "module example.com/my-api\n\ngo 1.23\n\nrequire github.com/example/direct v1.2.3\n\nreplace github.com/example/direct => "+dependencyPath+"\n")
	writeFile(t, filepath.Join(projectPath, "main.go"), "package main\n\nfunc main() {}\n")
	writeFile(t, filepath.Join(projectPath, "handler.go"), "package main\n\nfunc handler() {}\n")
	writeFile(t, filepath.Join(projectPath, "handler_test.go"), "package main\n\nimport \"testing\"\n\nfunc TestHandler(t *testing.T) {}\n")
	writeFile(t, filepath.Join(projectPath, "cmd", "api", "api.go"), "package api\n\nfunc Start() {}\n")
	writeFile(t, filepath.Join(projectPath, "internal", "service", "service.go"), "package service\n\nfunc Name() string { return \"service\" }\n")
	writeFile(t, filepath.Join(projectPath, "README.md"), "fixture\n")
	writeFile(t, filepath.Join(projectPath, ".git", "config"), "git config\n")
	writeFile(t, filepath.Join(projectPath, "bin", "app.exe"), "binary\n")
	writeFile(t, filepath.Join(projectPath, ".test-gocache", "cache.data"), "cache\n")
	return projectPath
}

func writeFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", path, err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func containsError(err error, want string) bool {
	return err != nil && (errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), want))
}
