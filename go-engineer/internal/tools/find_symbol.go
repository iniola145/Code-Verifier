package tools

import (
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const maxSymbolMatches = 200

type SymbolSearchResult struct {
	Symbol    string        `json:"symbol"`
	Matches   []SymbolMatch `json:"matches"`
	Warnings  []string      `json:"warnings"`
	Truncated bool          `json:"truncated"`
}
type SymbolMatch struct {
	File        string `json:"file"`
	Package     string `json:"package"`
	PackagePath string `json:"package_path"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Receiver    string `json:"receiver,omitempty"`
	Exported    bool   `json:"exported"`
	StartLine   int    `json:"start_line"`
	EndLine     int    `json:"end_line"`
	TestFile    bool   `json:"test_file"`
}

func FindGoSymbol(ctx context.Context, projectPath, symbol, kind, receiver, packagePath string) (SymbolSearchResult, error) {
	out := SymbolSearchResult{Symbol: symbol, Matches: []SymbolMatch{}, Warnings: []string{}}
	if ctx == nil {
		return out, errors.New("context is required")
	}
	root, e := validateProjectPath(projectPath)
	if e != nil {
		return out, e
	}
	if strings.TrimSpace(symbol) == "" {
		return out, errors.New("symbol is required")
	}
	base := root
	if packagePath != "" {
		if filepath.IsAbs(packagePath) {
			return out, errors.New("package path must be relative")
		}
		c := filepath.Clean(packagePath)
		if c == ".." || strings.HasPrefix(c, ".."+string(filepath.Separator)) {
			return out, errors.New("package path must remain inside the project")
		}
		base = filepath.Join(root, c)
		s, e := os.Stat(base)
		if e != nil || !s.IsDir() {
			return out, fmt.Errorf("package directory does not exist: %s", packagePath)
		}
	}
	e = filepath.WalkDir(base, func(path string, d os.DirEntry, we error) error {
		if we != nil {
			return we
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "vendor", "bin", ".test-gocache":
				return filepath.SkipDir
			}
			if packagePath != "" && path != base {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(d.Name()) != ".go" {
			return nil
		}
		src, er := os.ReadFile(path)
		if er != nil {
			return er
		}
		fs := token.NewFileSet()
		f, er := parser.ParseFile(fs, path, src, 0)
		if er != nil {
			out.Warnings = append(out.Warnings, fmt.Sprintf("skipped %s: %v", relPath(root, path), er))
			return nil
		}
		pd, _ := filepath.Rel(root, filepath.Dir(path))
		pd = filepath.ToSlash(pd)
		if pd == "." {
			pd = "."
		}
		for _, decl := range f.Decls {
			m := matchDecl(decl, symbol, kind, receiver)
			if m != nil {
				out.Matches = append(out.Matches, SymbolMatch{relPath(root, path), f.Name.Name, pd, m.kind, symbol, m.receiver, ast.IsExported(symbol), fs.Position(decl.Pos()).Line, fs.Position(decl.End()).Line, strings.HasSuffix(d.Name(), "_test.go")})
			}
		}
		return nil
	})
	if e != nil {
		return out, fmt.Errorf("scan Go symbols: %w", e)
	}
	sort.Slice(out.Matches, func(i, j int) bool {
		a, b := out.Matches[i], out.Matches[j]
		if a.PackagePath != b.PackagePath {
			return a.PackagePath < b.PackagePath
		}
		if a.File != b.File {
			return a.File < b.File
		}
		if a.StartLine != b.StartLine {
			return a.StartLine < b.StartLine
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.Receiver < b.Receiver
	})
	if len(out.Matches) > maxSymbolMatches {
		out.Truncated = true
		out.Matches = out.Matches[:maxSymbolMatches]
	}
	sort.Strings(out.Warnings)
	return out, nil
}

type symbolMatch struct{ kind, receiver string }

func matchDecl(d ast.Decl, want, kind, recv string) *symbolMatch {
	switch x := d.(type) {
	case *ast.FuncDecl:
		if x.Name.Name != want {
			return nil
		}
		if recv != "" && x.Recv == nil {
			return nil
		}
		k, r := "function", ""
		if x.Recv != nil {
			k = "method"
			r = exprString(x.Recv.List[0].Type)
			if recv != "" && strings.TrimPrefix(r, "*") != strings.TrimPrefix(recv, "*") {
				return nil
			}
		}
		if kind != "" && kind != k {
			return nil
		}
		return &symbolMatch{k, r}
	case *ast.GenDecl:
		for _, s := range x.Specs {
			switch n := s.(type) {
			case *ast.TypeSpec:
				if n.Name.Name == want {
					k := "type"
					switch n.Type.(type) {
					case *ast.StructType:
						k = "struct"
					case *ast.InterfaceType:
						k = "interface"
					}
					if kind == "" || kind == k {
						return &symbolMatch{k, ""}
					}
				}
			case *ast.ValueSpec:
				for _, id := range n.Names {
					if id.Name == want {
						k := "var"
						if x.Tok == token.CONST {
							k = "const"
						}
						if kind == "" || kind == k {
							return &symbolMatch{k, ""}
						}
					}
				}
			}
		}
	}
	return nil
}
func relPath(root, path string) string { r, _ := filepath.Rel(root, path); return filepath.ToSlash(r) }
