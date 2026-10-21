package tools

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectGoSymbol(t *testing.T) {
	p := t.TempDir()
	writeFile(t, filepath.Join(p, "go.mod"), "module example.com/symbol\n\ngo 1.23\n")
	writeFile(t, filepath.Join(p, "source.go"), `package sample
type User struct{}
type Other struct{}
type Reader interface { Read() error }
const Limit = 1
const ( A, B = 10, 20 )
var Name = "x"
var first, second = 1, 2
func Parse(value string) (*User, error) { return nil, nil }
func (u *User) Save() error { return nil }
func (u Other) Save() error { return nil }
`)
	got, err := InspectGoSymbol(context.Background(), p, "source.go", "Parse", "")
	if err != nil || got.Symbol.Kind != "function" || got.Symbol.StartLine != 9 || got.Symbol.EndLine != 9 || !strings.Contains(got.Symbol.Source, "func Parse") {
		t.Fatalf("%#v %v", got, err)
	}
	got, err = InspectGoSymbol(context.Background(), p, "source.go", "Save", "User")
	if err != nil || got.Symbol.Receiver != "*User" {
		t.Fatalf("%#v %v", got, err)
	}
	if _, err = InspectGoSymbol(context.Background(), p, "source.go", "Save", ""); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatal(err)
	}
	for _, s := range []string{"User", "Reader", "Limit", "Name"} {
		got, err = InspectGoSymbol(context.Background(), p, "source.go", s, "")
		if err != nil {
			t.Fatal(err)
		}
		if s == "User" || s == "Reader" {
			if !strings.Contains(got.Symbol.Source, "type ") {
				t.Errorf("%s source = %q", s, got.Symbol.Source)
			}
		}
		if s == "Limit" && !strings.HasPrefix(got.Symbol.Source, "const ") {
			t.Errorf("constant source = %q", got.Symbol.Source)
		}
		if s == "Name" && !strings.HasPrefix(got.Symbol.Source, "var ") {
			t.Errorf("variable source = %q", got.Symbol.Source)
		}
	}

	multiConst, err := InspectGoSymbol(context.Background(), p, "source.go", "B", "")
	if err != nil || multiConst.Symbol.Name != "B" || !multiConst.Symbol.Exported || multiConst.Symbol.Kind != "constant" {
		t.Fatalf("multiConst = %#v, err = %v", multiConst, err)
	}
	multiVar, err := InspectGoSymbol(context.Background(), p, "source.go", "second", "")
	if err != nil || multiVar.Symbol.Name != "second" || multiVar.Symbol.Exported || multiVar.Symbol.Kind != "variable" {
		t.Fatalf("multiVar = %#v, err = %v", multiVar, err)
	}
}
func TestInspectGoSymbolValidationAndTruncation(t *testing.T) {
	p := t.TempDir()
	writeFile(t, filepath.Join(p, "go.mod"), "module example.com/symbol\n\ngo 1.23\n")
	writeFile(t, filepath.Join(p, "big.go"), "package p\nfunc Big(){\n"+strings.Repeat("var x = 1\n", 20000)+"}\n")
	got, err := InspectGoSymbol(context.Background(), p, "big.go", "Big", "")
	if err != nil || !got.Symbol.Truncated {
		t.Fatalf("%#v %v", got, err)
	}
	for _, f := range []string{filepath.Join(p, "big.go"), "../x"} {
		if _, err = InspectGoSymbol(context.Background(), p, f, "Big", ""); err == nil {
			t.Errorf("accepted %s", f)
		}
	}
	writeFile(t, filepath.Join(p, "note.txt"), "x")
	if _, err = InspectGoSymbol(context.Background(), p, "note.txt", "x", ""); err == nil {
		t.Error("accepted non-Go")
	}
}
func TestReviewEmptyCollectionsSerializeAsArrays(t *testing.T) {
	review := APIReview{}
	normalizeAPIReview(&review)
	b, _ := json.Marshal(review)
	if strings.Contains(string(b), `"findings":null`) {
		t.Fatal(string(b))
	}
}
