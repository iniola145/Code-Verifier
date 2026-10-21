package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindGoSymbolKindsAndMetadata(t *testing.T) {
	p := symbolProject(t)
	checks := []struct{ name, kind string }{{"DoProcess", "function"}, {"Service", "struct"}, {"Store", "interface"}, {"UserID", "type"}, {"DefaultLimit", "const"}, {"StatusPending", "const"}, {"Global", "var"}, {"ErrNotFound", "var"}}
	for _, check := range checks {
		got, err := FindGoSymbol(context.Background(), p, check.name, "", "", "")
		if err != nil || len(got.Matches) != 1 || got.Matches[0].Kind != check.kind {
			t.Errorf("%s = %#v, error %v", check.name, got, err)
		}
	}
	got, err := FindGoSymbol(context.Background(), p, "Process", "", "", "")
	if err != nil || got.Matches[0].Package != "sample" || got.Matches[0].PackagePath != "internal/service" || !got.Matches[0].Exported || got.Matches[0].StartLine != 3 {
		t.Fatalf("metadata = %#v, error %v", got, err)
	}
}

func TestFindGoSymbolMethodsFiltersAndExactNames(t *testing.T) {
	p := symbolProject(t)
	got, err := FindGoSymbol(context.Background(), p, "Process", "method", "Service", "")
	if err != nil || len(got.Matches) != 1 {
		t.Fatalf("methods = %#v, error %v", got, err)
	}
	got, err = FindGoSymbol(context.Background(), p, "Process", "method", "*Service", "internal/service")
	if err != nil || len(got.Matches) != 1 || got.Matches[0].Receiver != "*Service" {
		t.Fatalf("receiver = %#v, error %v", got, err)
	}
	got, err = FindGoSymbol(context.Background(), p, "Process", "", "Other", "")
	if err != nil || len(got.Matches) != 1 || got.Matches[0].Receiver != "Other" {
		t.Fatalf("other receiver = %#v", got)
	}
	got, err = FindGoSymbol(context.Background(), p, "Process", "", "", "internal/service")
	if err != nil || len(got.Matches) != 4 {
		t.Fatal(err)
	}
	for _, name := range []string{"ProcessRequest", "ProcessHandler", "DoProcess"} {
		got, _ = FindGoSymbol(context.Background(), p, "Process", "", "", "")
		for _, match := range got.Matches {
			if match.Name == name {
				t.Errorf("prefix/suffix %s matched", name)
			}
		}
	}
}

func TestFindGoSymbolRecursiveTestsWarningsAndSorting(t *testing.T) {
	p := symbolProject(t)
	writeFile(t, filepath.Join(p, "bad.go"), "package broken\nfunc {")
	got, err := FindGoSymbol(context.Background(), p, "Process", "", "", "")
	if err != nil || len(got.Matches) != 5 || len(got.Warnings) != 1 {
		t.Fatalf("result = %#v, error %v", got, err)
	}
	if !got.Matches[3].TestFile {
		t.Errorf("test match = %#v", got.Matches[3])
	}
	if got.Matches[0].PackagePath > got.Matches[1].PackagePath {
		t.Error("matches are not sorted")
	}
	got, err = FindGoSymbol(context.Background(), p, "Missing", "", "", "")
	if err != nil || got.Matches == nil || len(got.Matches) != 0 || got.Truncated {
		t.Fatalf("empty = %#v, error %v", got, err)
	}
	b, _ := json.Marshal(got)
	if !strings.Contains(string(b), `"matches":[]`) || !strings.Contains(string(b), `"warnings":[`) {
		t.Fatal(string(b))
	}
}

func TestFindGoSymbolExclusionsAndTruncation(t *testing.T) {
	p := symbolProject(t)
	for _, d := range []string{".git", "vendor", "bin", ".test-gocache"} {
		writeFile(t, filepath.Join(p, d, "ignored.go"), "package ignored\nfunc Process(){}\n")
	}
	for i := 0; i < 201; i++ {
		writeFile(t, filepath.Join(p, "many", fmt.Sprintf("f%03d.go", i)), "package many\nfunc Process(){}\n")
	}
	got, err := FindGoSymbol(context.Background(), p, "Process", "", "", "many")
	if err != nil || len(got.Matches) != 200 || !got.Truncated {
		t.Fatalf("truncation=%#v error=%v", got, err)
	}
}

func TestFindGoSymbolInvalidProjectAndPackage(t *testing.T) {
	p := t.TempDir()
	for _, path := range []string{filepath.Join(p, "missing"), p} {
		if path == p {
			writeFile(t, filepath.Join(p, "note.go"), "package p\n")
		}
		_, err := FindGoSymbol(context.Background(), path, "X", "", "", "")
		if err == nil {
			t.Errorf("accepted %s", path)
		}
	}
	p = symbolProject(t)
	for _, pkg := range []string{"../outside", "internal/missing"} {
		_, err := FindGoSymbol(context.Background(), p, "X", "", "", pkg)
		if err == nil {
			t.Errorf("accepted package %s", pkg)
		}
	}
}

func symbolProject(t *testing.T) string {
	t.Helper()
	p := t.TempDir()
	writeFile(t, filepath.Join(p, "go.mod"), "module example.com/find\n\ngo 1.23\n")
	writeFile(t, filepath.Join(p, "internal", "service", "service.go"), `package sample
type Service struct{}
func Process() {}
func (s *Service) Process() {}
type Store interface { Save() error }
type UserID string
const DefaultLimit = 10
const ( StatusPending = "pending"; StatusDone = "done" )
var Global = 1
var ( ErrNotFound = "missing"; ErrConflict = "conflict" )
func DoProcess() {}
`)
	writeFile(t, filepath.Join(p, "internal", "service", "other.go"), "package sample\ntype Other struct{}\nfunc (o Other) Process() {}\n")
	writeFile(t, filepath.Join(p, "internal", "service", "service_test.go"), "package sample\nfunc TestProcess(){}\nfunc Process(){}\n")
	writeFile(t, filepath.Join(p, "internal", "service", "foo", "nested.go"), "package nested\nfunc Process(){}\n")
	return p
}

var _ = os.ErrNotExist
