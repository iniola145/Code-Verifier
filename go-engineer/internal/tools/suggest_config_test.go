package tools

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSuggestProjectConfig(t *testing.T) {
	p := t.TempDir()
	writeFile(t, filepath.Join(p, "go.mod"), "module example.com/suggest\n\ngo 1.23\n")
	writeFile(t, filepath.Join(p, "cmd", "api", "main.go"), `package main
import "github.com/go-chi/chi/v5"
func main(){ chi.NewRouter() }`)
	writeFile(t, filepath.Join(p, "internal", "handlers", "handler.go"), "package handlers\n")
	writeFile(t, filepath.Join(p, "internal", "services", "service.go"), "package services\n")
	writeFile(t, filepath.Join(p, "internal", "repositories", "repo.go"), "package repositories\n")
	got, err := SuggestProjectConfig(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if got.SuggestedConfig.Version != 1 || got.SuggestedConfig.HTTP.Router != "chi" || got.SuggestedConfig.Project.Architecture != "layered" {
		t.Fatalf("suggestion=%#v", got.SuggestedConfig)
	}
	if len(got.SuggestedConfig.Packages.Services) != 1 || got.SuggestedConfig.Testing.DefaultPackage != "./..." {
		t.Fatalf("packages=%#v", got.SuggestedConfig)
	}
}
func TestSuggestConfigMissingAndReadOnly(t *testing.T) {
	p := t.TempDir()
	writeFile(t, filepath.Join(p, "go.mod"), "module example.com/suggest\n\ngo 1.23\n")
	writeFile(t, filepath.Join(p, "main.go"), "package main\n")
	before, _ := os.ReadFile(filepath.Join(p, "main.go"))
	a, e := SuggestProjectConfig(context.Background(), p)
	if e != nil || a.ExistingConfig {
		t.Fatal(e)
	}
	writeFile(t, p+"/.go-engineer.yaml", "version: 1\nhttp: {router: gin}\n")
	beforeCfg, _ := os.ReadFile(filepath.Join(p, ".go-engineer.yaml"))
	b, e := SuggestProjectConfig(context.Background(), p)
	if e != nil || !b.ExistingConfig {
		t.Fatal(e)
	}
	after, _ := os.ReadFile(filepath.Join(p, ".go-engineer.yaml"))
	if !reflect.DeepEqual(beforeCfg, after) {
		t.Fatal("configuration modified")
	}
	afterSrc, _ := os.ReadFile(filepath.Join(p, "main.go"))
	if !reflect.DeepEqual(before, afterSrc) {
		t.Fatal("source modified")
	}
}
