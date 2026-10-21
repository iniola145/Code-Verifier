package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestInspectGoPackage(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/package\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "internal", "tools", "a.go"), `package tools
import "context"
type Public struct { ID *int }
type private interface { Do(context.Context) error }
func Exported(ctx context.Context) (*Public, error) { return nil, nil }
func (p *Public) Save(values []string) map[string]int { return nil }
const PublicConst = 1
var privateVar = 2
`)
	writeFile(t, filepath.Join(project, "internal", "tools", "b.go"), `package tools
import "fmt"
type Service interface { Start() error }
func privateFunction() { fmt.Println("x") }
`)
	writeFile(t, filepath.Join(project, "internal", "tools", "a_test.go"), `package tools_test
import "testing"
func TestPublic(t *testing.T) {}
`)
	writeFile(t, filepath.Join(project, "internal", "tools", "nested", "ignored.go"), "package ignored\n")

	got, err := InspectGoPackage(context.Background(), project, "internal/tools")
	if err != nil {
		t.Fatal(err)
	}
	if got.Package != "tools" || got.Path != "internal/tools" {
		t.Fatalf("identity = %#v", got)
	}
	if !reflect.DeepEqual(got.Files, []string{"a.go", "b.go"}) || !reflect.DeepEqual(got.TestFiles, []string{"a_test.go"}) {
		t.Errorf("files = %#v", got)
	}
	if !reflect.DeepEqual(got.Imports, []string{"context", "fmt", "testing"}) {
		t.Errorf("imports = %v", got.Imports)
	}
	if !got.HasTests || len(got.Structs) != 1 || !got.Structs[0].Exported {
		t.Errorf("structs = %#v", got.Structs)
	}
	if len(got.Interfaces) != 2 || len(got.Functions) != 2 || len(got.Methods) != 1 {
		t.Errorf("declarations = %#v", got)
	}
	if got.Functions[0].Name != "Exported" || !got.Functions[0].Exported || got.Functions[1].Exported {
		t.Errorf("function exports = %#v", got.Functions)
	}
	if got.Methods[0].Receiver != "*Public" {
		t.Errorf("methods = %#v", got.Methods)
	}
	if got.Types[0].Name != "Public" || !got.Types[0].Exported || got.Constants[0].Exported != true || got.Variables[0].Exported {
		t.Errorf("export metadata = %#v", got)
	}
}

func TestInspectGoPackageNoTests(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/package\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "plain.go"), "package plain\n")
	got, err := InspectGoPackage(context.Background(), project, ".")
	if err != nil || got.HasTests || got.TestFiles == nil || len(got.TestFiles) != 0 {
		t.Fatalf("result = %#v, error = %v", got, err)
	}
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"files":["plain.go"]`) {
		t.Errorf("files was not populated: %s", b)
	}
	for _, field := range []string{"test_files", "imports", "functions", "methods", "structs", "interfaces", "types", "constants", "variables"} {
		if !strings.Contains(string(b), `"`+field+`":[]`) {
			t.Errorf("JSON field %s was not an empty array: %s", field, b)
		}
	}
}

func TestInspectGoPackageValidation(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/package\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "valid.go"), "package valid\n")
	tests := []struct{ name, path, want string }{
		{"absolute", filepath.Join(project, "valid.go"), "relative"},
		{"traversal", "../outside", "inside the project"},
		{"missing", "missing", "does not exist"},
		{"no Go files", "empty", "no Go source files"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.name == "no Go files" {
				if err := os.Mkdir(filepath.Join(project, tt.path), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			_, err := InspectGoPackage(context.Background(), project, tt.path)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestInspectGoPackageInconsistentProductionPackages(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/package\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "one.go"), "package one\n")
	writeFile(t, filepath.Join(project, "two.go"), "package two\n")
	_, err := InspectGoPackage(context.Background(), project, ".")
	if err == nil || !strings.Contains(err.Error(), "inconsistent production package") {
		t.Fatalf("error = %v", err)
	}
}
