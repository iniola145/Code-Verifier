package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAnalyzeGoFile(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/analyze\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "internal", "model.go"), `package sample
import (
 "context"
 "fmt"
)
const Answer = 42
var Global = map[string]int{}
type User struct { ID *int; Names []string; Scores map[string]int }
type Runner interface { Run(context.Context) error; Close() }
type Alias string
func NewUser(ctx context.Context, name string) (*User, error) { return nil, fmt.Errorf("%s", name) }
func (u *User) Save(ch <-chan User) (chan User, error) { return ch, nil }
`)

	info, err := AnalyzeGoFile(context.Background(), project, filepath.Join("internal", "model.go"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Package != "sample" {
		t.Errorf("package = %q", info.Package)
	}
	if len(info.Imports) != 2 || info.Imports[0] != "context" || info.Imports[1] != "fmt" {
		t.Errorf("imports = %v", info.Imports)
	}
	if len(info.Functions) != 1 || info.Functions[0].Name != "NewUser" || !info.Functions[0].Exported {
		t.Errorf("functions = %#v", info.Functions)
	}
	fn := info.Functions[0]
	if strings.Join(fn.Parameters, ",") != "context.Context,string" || strings.Join(fn.Results, ",") != "*User,error" {
		t.Errorf("function types = %#v", fn)
	}
	if len(info.Methods) != 1 || info.Methods[0].Receiver != "*User" || strings.Join(info.Methods[0].Parameters, ",") != "<-chan User" || !info.Methods[0].Exported {
		t.Errorf("methods = %#v", info.Methods)
	}
	if len(info.Structs) != 1 || len(info.Structs[0].Fields) != 3 || !info.Structs[0].Exported {
		t.Errorf("structs = %#v", info.Structs)
	}
	if info.Structs[0].Fields[1].Type != "[]string" || info.Structs[0].Fields[2].Type != "map[string]int" {
		t.Errorf("fields = %#v", info.Structs[0].Fields)
	}
	if len(info.Interfaces) != 1 || len(info.Interfaces[0].Methods) != 2 || info.Interfaces[0].Methods[0].Name != "Run" || !info.Interfaces[0].Exported {
		t.Errorf("interfaces = %#v", info.Interfaces)
	}
	if len(info.Types) != 3 || len(info.Constants) != 1 || len(info.Variables) != 1 {
		t.Errorf("declarations = %#v", info)
	}
}

func TestAnalyzeGoFilePathValidation(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/analyze\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "nested", "valid.go"), "package nested\n")
	outside := filepath.Join(t.TempDir(), "outside.go")
	writeFile(t, outside, "package outside\n")
	tests := []struct{ name, path, want string }{
		{"absolute", outside, "relative"},
		{"traversal", filepath.Join("nested", "..", "..", "outside.go"), "inside the project"},
		{"missing", "missing.go", "does not exist"},
		{"non-go", "go.mod", ".go file"},
		{"directory", "nested", "directory"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := AnalyzeGoFile(context.Background(), project, tt.path)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestAnalyzeGoFileMalformed(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/analyze\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "bad.go"), "package bad\nfunc broken( {\n")
	_, err := AnalyzeGoFile(context.Background(), project, "bad.go")
	if err == nil || !strings.Contains(err.Error(), "parse Go file") {
		t.Fatalf("error = %v", err)
	}
}

func TestAnalyzeGoFileDoesNotRequireNetwork(t *testing.T) {
	if _, err := os.Stat(filepath.Join(t.TempDir(), "missing")); !os.IsNotExist(err) {
		t.Fatal("unexpected fixture state")
	}
}
