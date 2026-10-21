package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

const maxSymbolSource = 100 * 1024

type GoSymbolInfo struct {
	File    string   `json:"file"`
	Package string   `json:"package"`
	Symbol  GoSymbol `json:"symbol"`
}
type GoSymbol struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Receiver  string `json:"receiver,omitempty"`
	Exported  bool   `json:"exported"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Source    string `json:"source"`
	Truncated bool   `json:"truncated"`
}

func InspectGoSymbol(ctx context.Context, projectPath, filePath, symbol, receiver string) (GoSymbolInfo, error) {
	var result GoSymbolInfo
	if ctx == nil {
		return result, errors.New("context is required")
	}
	project, err := validateProjectPath(projectPath)
	if err != nil {
		return result, err
	}
	if filepath.IsAbs(filePath) || strings.TrimSpace(filePath) == "" {
		return result, errors.New("file path must be a non-empty relative path")
	}
	clean := filepath.Clean(filePath)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return result, errors.New("file path must remain inside the project")
	}
	path, err := canonicalPath(filepath.Join(project, clean))
	if err != nil {
		return result, fmt.Errorf("file does not exist: %s", filePath)
	}
	rel, err := filepath.Rel(project, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return result, errors.New("file path must remain inside the project")
	}
	st, err := os.Stat(path)
	if err != nil {
		return result, fmt.Errorf("stat Go file: %w", err)
	}
	if st.IsDir() {
		return result, errors.New("file path is a directory")
	}
	if filepath.Ext(path) != ".go" {
		return result, errors.New("file path must refer to a .go file")
	}
	if strings.TrimSpace(symbol) == "" {
		return result, errors.New("symbol is required")
	}
	src, err := os.ReadFile(path)
	if err != nil {
		return result, fmt.Errorf("read Go file: %w", err)
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, src, parser.ParseComments)
	if err != nil {
		return result, fmt.Errorf("parse Go file: %w", err)
	}
	type match struct {
		node ast.Node
		decl *ast.GenDecl
		spec ast.Spec
	}
	var matches []match
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Name.Name == symbol && receiverMatches(d, receiver) {
				matches = append(matches, match{node: d})
			}
		case *ast.GenDecl:
			for _, s := range d.Specs {
				if n, ok := s.(*ast.TypeSpec); ok && n.Name.Name == symbol {
					matches = append(matches, match{node: n, decl: d, spec: n})
				}
				if n, ok := s.(*ast.ValueSpec); ok {
					for _, name := range n.Names {
						if name.Name == symbol {
							matches = append(matches, match{node: n, decl: d, spec: n})
						}
					}
				}
			}
		}
	}
	if len(matches) == 0 {
		return result, fmt.Errorf("symbol not found: %s", symbol)
	}
	if len(matches) > 1 && receiver == "" {
		return result, fmt.Errorf("symbol %q is ambiguous; specify a receiver", symbol)
	}
	if len(matches) > 1 {
		return result, fmt.Errorf("symbol %q is ambiguous", symbol)
	}
	m := matches[0]
	node := m.node
	start := fset.Position(node.Pos())
	end := fset.Position(node.End())
	raw := src[start.Offset:end.Offset]
	if m.decl != nil {
		var b bytes.Buffer
		if ts, ok := m.spec.(*ast.TypeSpec); ok {
			_, _ = b.WriteString("type ")
			_ = format.Node(&b, fset, ts)
		} else if vs, ok := m.spec.(*ast.ValueSpec); ok {
			if m.decl.Tok == token.CONST {
				_, _ = b.WriteString("const ")
			} else {
				_, _ = b.WriteString("var ")
			}
			selected := &ast.ValueSpec{Names: []*ast.Ident{}, Type: vs.Type}
			for i, n := range vs.Names {
				if n.Name == symbol {
					selected.Names = append(selected.Names, n)
					if i < len(vs.Values) {
						selected.Values = []ast.Expr{vs.Values[i]}
					}
				}
			}
			_ = format.Node(&b, fset, selected)
		}
		raw = b.Bytes()
	}
	truncated := len(raw) > maxSymbolSource
	if truncated {
		raw = raw[:maxSymbolSource]
	}
	info := GoSymbolInfo{File: filepath.ToSlash(clean), Package: file.Name.Name, Symbol: GoSymbolInfoFor(node, string(raw), truncated, start.Line, end.Line)}
	if m.decl != nil && (m.decl.Tok == token.CONST || m.decl.Tok == token.VAR) {
		info.Symbol.Name = symbol
		info.Symbol.Exported = ast.IsExported(symbol)
	}
	if m.decl != nil && m.decl.Tok == token.CONST {
		info.Symbol.Kind = "constant"
	}
	return info, nil
}

func receiverMatches(d *ast.FuncDecl, want string) bool {
	if d.Recv == nil {
		return want == ""
	}
	if want == "" {
		return true
	}
	got := exprString(d.Recv.List[0].Type)
	got = strings.TrimPrefix(got, "*")
	want = strings.TrimPrefix(want, "*")
	return got == want
}
func GoSymbolInfoFor(node ast.Node, source string, truncated bool, start, end int) GoSymbol {
	s := GoSymbol{StartLine: start, EndLine: end, Source: source, Truncated: truncated}
	switch n := node.(type) {
	case *ast.FuncDecl:
		s.Name = n.Name.Name
		s.Exported = ast.IsExported(s.Name)
		if n.Recv == nil {
			s.Kind = "function"
		} else {
			s.Kind = "method"
			s.Receiver = exprString(n.Recv.List[0].Type)
		}
	case *ast.TypeSpec:
		s.Name = n.Name.Name
		s.Exported = ast.IsExported(s.Name)
		switch n.Type.(type) {
		case *ast.StructType:
			s.Kind = "struct"
		case *ast.InterfaceType:
			s.Kind = "interface"
		default:
			s.Kind = "type"
		}
	case *ast.ValueSpec:
		s.Name = ""
		for _, x := range n.Names {
			if s.Name != "" {
				s.Name += ","
			}
			s.Name += x.Name
		}
		s.Exported = ast.IsExported(strings.Split(s.Name, ",")[0])
		s.Kind = "variable"
	}
	return s
}
