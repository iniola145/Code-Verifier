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

type GoFileInfo struct {
	Package    string        `json:"package"`
	Imports    []string      `json:"imports"`
	Functions  []GoFunction  `json:"functions"`
	Methods    []GoFunction  `json:"methods"`
	Structs    []GoStruct    `json:"structs"`
	Interfaces []GoInterface `json:"interfaces"`
	Types      []string      `json:"types"`
	Constants  []string      `json:"constants"`
	Variables  []string      `json:"variables"`
}

type GoFunction struct {
	Name       string   `json:"name"`
	Receiver   string   `json:"receiver,omitempty"`
	Parameters []string `json:"parameters"`
	Results    []string `json:"results"`
	Exported   bool     `json:"exported"`
}

type GoStruct struct {
	Name     string    `json:"name"`
	Fields   []GoField `json:"fields"`
	Exported bool      `json:"exported"`
}
type GoField struct {
	Names []string `json:"names"`
	Type  string   `json:"type"`
}
type GoInterface struct {
	Name     string              `json:"name"`
	Methods  []GoInterfaceMethod `json:"methods"`
	Exported bool                `json:"exported"`
}
type GoInterfaceMethod struct {
	Name      string `json:"name"`
	Signature string `json:"signature"`
}

func AnalyzeGoFile(ctx context.Context, projectPath, filePath string) (GoFileInfo, error) {
	var info GoFileInfo
	if ctx == nil {
		return info, errors.New("context is required")
	}
	project, err := validateProjectPath(projectPath)
	if err != nil {
		return info, err
	}
	if filepath.IsAbs(filePath) || strings.TrimSpace(filePath) == "" {
		return info, errors.New("file path must be a non-empty relative path")
	}
	clean := filepath.Clean(filePath)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return info, errors.New("file path must remain inside the project")
	}
	candidate := filepath.Join(project, clean)
	canonicalProject := filepath.Clean(project)
	canonicalFile, err := canonicalPath(candidate)
	if err != nil {
		return info, fmt.Errorf("file does not exist: %s", filePath)
	}
	relative, err := filepath.Rel(canonicalProject, canonicalFile)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return info, errors.New("file path must remain inside the project")
	}
	fileInfo, err := os.Stat(canonicalFile)
	if err != nil {
		return info, fmt.Errorf("stat Go file: %w", err)
	}
	if fileInfo.IsDir() {
		return info, errors.New("file path is a directory")
	}
	if filepath.Ext(canonicalFile) != ".go" {
		return info, errors.New("file path must refer to a .go file")
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, canonicalFile, nil, parser.ParseComments)
	if err != nil {
		return info, fmt.Errorf("parse Go file: %w", err)
	}
	return analyzeAST(file)
}

func canonicalPath(path string) (string, error) {
	canonical, err := filepath.EvalSymlinks(path)
	if err == nil {
		return canonical, nil
	}
	// Some restricted Windows environments deny symlink resolution entirely.
	// The lexical boundary checks still reject absolute paths and traversal.
	if errors.Is(err, os.ErrPermission) {
		return filepath.Clean(path), nil
	}
	return "", err
}

func analyzeAST(file *ast.File) (GoFileInfo, error) {
	info := GoFileInfo{Package: file.Name.Name, Imports: []string{}, Functions: []GoFunction{}, Methods: []GoFunction{}, Structs: []GoStruct{}, Interfaces: []GoInterface{}, Types: []string{}, Constants: []string{}, Variables: []string{}}
	for _, imp := range file.Imports {
		info.Imports = append(info.Imports, strings.Trim(imp.Path.Value, `"`))
	}
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			fn := GoFunction{Name: d.Name.Name, Parameters: fieldTypes(d.Type.Params), Results: fieldTypes(d.Type.Results), Exported: ast.IsExported(d.Name.Name)}
			if d.Recv == nil {
				info.Functions = append(info.Functions, fn)
			} else {
				fn.Receiver = exprString(d.Recv.List[0].Type)
				info.Methods = append(info.Methods, fn)
			}
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				ts, ok := spec.(*ast.TypeSpec)
				if ok {
					info.Types = append(info.Types, ts.Name.Name)
					switch typ := ts.Type.(type) {
					case *ast.StructType:
						info.Structs = append(info.Structs, GoStruct{Name: ts.Name.Name, Fields: structFields(typ.Fields), Exported: ast.IsExported(ts.Name.Name)})
					case *ast.InterfaceType:
						info.Interfaces = append(info.Interfaces, GoInterface{Name: ts.Name.Name, Methods: interfaceMethods(typ.Methods), Exported: ast.IsExported(ts.Name.Name)})
					}
				}
				vs, ok := spec.(*ast.ValueSpec)
				if ok {
					names := make([]string, 0, len(vs.Names))
					for _, n := range vs.Names {
						names = append(names, n.Name)
					}
					if d.Tok == token.CONST {
						info.Constants = append(info.Constants, names...)
					} else if d.Tok == token.VAR {
						info.Variables = append(info.Variables, names...)
					}
				}
			}
		}
	}
	return info, nil
}

func exprString(expr ast.Expr) string {
	var b bytes.Buffer
	if err := format.Node(&b, token.NewFileSet(), expr); err != nil {
		return "<unprintable>"
	}
	return b.String()
}
func fieldTypes(fields *ast.FieldList) []string {
	if fields == nil {
		return []string{}
	}
	result := []string{}
	for _, f := range fields.List {
		result = append(result, exprString(f.Type))
	}
	return result
}
func structFields(fields *ast.FieldList) []GoField {
	result := []GoField{}
	for _, f := range fields.List {
		names := []string{}
		for _, n := range f.Names {
			names = append(names, n.Name)
		}
		result = append(result, GoField{Names: names, Type: exprString(f.Type)})
	}
	return result
}
func interfaceMethods(fields *ast.FieldList) []GoInterfaceMethod {
	result := []GoInterfaceMethod{}
	for _, f := range fields.List {
		for _, n := range f.Names {
			result = append(result, GoInterfaceMethod{Name: n.Name, Signature: exprString(f.Type)})
		}
	}
	return result
}
