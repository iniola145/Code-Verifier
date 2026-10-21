package tools

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestReviewAPIDesign(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/review\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "api.go"), `package api
import ("context"; "database/sql"; "fmt"; "net/http"; "strings")
func Create(w http.ResponseWriter, r *http.Request, ctx context.Context, db *sql.DB) {
	db.QueryContext(r.Context(), "x")
	context.Background()
	panic("x")
	query := fmt.Sprintf("SELECT * FROM users WHERE id = '%s'", r.URL.Query().Get("id"))
	db.Query(query)
	resp, _ := http.Get("http://example.com")
	_ = resp
}
func Check(err error) bool { return err.Error() == "bad" || strings.Contains(err.Error(), "bad") }
func Routes(r *Router) { r.POST("/createUser", Create) }
type Router struct{}
`)
	got, err := ReviewAPIDesign(context.Background(), project, ".")
	if err != nil {
		t.Fatal(err)
	}
	wanted := map[string]bool{
		"handler-direct-db":                        true,
		"context-background-with-existing-context": true,
		"panic-request-path":                       true,
		"error-string-classification":              true,
		"rpc-style-route":                          true,
		"sql-raw-concatenation":                    true,
		"http-response-body-unclosed":              true,
	}
	for _, f := range got.Findings {
		delete(wanted, f.Rule)
	}
	for rule := range wanted {
		t.Errorf("missing rule %s", rule)
	}
	if got.Summary.FindingCount != len(got.Findings) || len(got.FilesReviewed) != 1 {
		t.Fatalf("summary = %#v", got.Summary)
	}
}

func TestReviewAPIDesignServiceLeakAndCleanPatterns(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/review\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "service", "service.go"), `package service
import "net/http"
func Work(w http.ResponseWriter, r *http.Request) { _ = w; _ = r }
`)
	got, err := ReviewAPIDesign(context.Background(), project, "service")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range got.Findings {
		if f.Rule == "service-http-dependency" {
			found = true
		}
	}
	if !found {
		t.Fatal("service HTTP dependency was not detected")
	}
	writeFile(t, filepath.Join(project, "service", "clean.go"), `package service
import "errors"
func Clean(err error) bool { return errors.Is(err, errors.New("x")) }
`)
	got, err = ReviewAPIDesign(context.Background(), project, "service")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range got.Findings {
		if f.Rule == "error-string-classification" {
			t.Fatal("errors.Is was flagged")
		}
	}
}

func TestReviewAPIDesignPathAndMalformed(t *testing.T) {
	project := t.TempDir()
	writeFile(t, filepath.Join(project, "go.mod"), "module example.com/review\n\ngo 1.23\n")
	writeFile(t, filepath.Join(project, "bad.go"), "package x\nfunc broken( {\n")
	for _, path := range []string{"../outside", filepath.Join(project, "bad.go")} {
		_, err := ReviewAPIDesign(context.Background(), project, path)
		if err == nil || (!strings.Contains(err.Error(), "inside") && !strings.Contains(err.Error(), "relative")) {
			t.Errorf("path %q error = %v", path, err)
		}
	}
	_, err := ReviewAPIDesign(context.Background(), project, ".")
	if err == nil || !strings.Contains(err.Error(), "parse bad.go") {
		t.Fatalf("malformed error = %v", err)
	}
}
