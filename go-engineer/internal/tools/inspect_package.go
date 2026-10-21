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

type GoPackageInfo struct {
	Package    string          `json:"package"`
	Path       string          `json:"path"`
	Files      []string        `json:"files"`
	TestFiles  []string        `json:"test_files"`
	Imports    []string        `json:"imports"`
	Structs    []GoStruct      `json:"structs"`
	Interfaces []GoInterface   `json:"interfaces"`
	Functions  []GoFunction    `json:"functions"`
	Methods    []GoFunction    `json:"methods"`
	Types      []GoDeclaration `json:"types"`
	Constants  []GoDeclaration `json:"constants"`
	Variables  []GoDeclaration `json:"variables"`
	HasTests   bool            `json:"has_tests"`
}

type GoDeclaration struct {
	Name     string `json:"name"`
	Exported bool   `json:"exported"`
}

func InspectGoPackage(ctx context.Context, projectPath, packagePath string) (GoPackageInfo, error) {
	var result GoPackageInfo
	if ctx == nil {
		return result, errors.New("context is required")
	}
	project, err := validateProjectPath(projectPath)
	if err != nil {
		return result, err
	}
	if filepath.IsAbs(packagePath) || strings.TrimSpace(packagePath) == "" {
		return result, errors.New("package path must be a non-empty relative path")
	}
	clean := filepath.Clean(packagePath)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return result, errors.New("package path must remain inside the project")
	}
	directory := filepath.Join(project, clean)
	canonicalProject := filepath.Clean(project)
	canonicalDirectory, err := canonicalPath(directory)
	if err != nil {
		return result, fmt.Errorf("package directory does not exist: %s", packagePath)
	}
	relative, err := filepath.Rel(canonicalProject, canonicalDirectory)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return result, errors.New("package path must remain inside the project")
	}
	stat, err := os.Stat(canonicalDirectory)
	if err != nil {
		return result, fmt.Errorf("stat package directory: %w", err)
	}
	if !stat.IsDir() {
		return result, errors.New("package path is not a directory")
	}
	entries, err := os.ReadDir(canonicalDirectory)
	if err != nil {
		return result, fmt.Errorf("read package directory: %w", err)
	}
	files := []string{}
	tests := []string{}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" {
			continue
		}
		if strings.HasSuffix(entry.Name(), "_test.go") {
			tests = append(tests, entry.Name())
		} else {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	sort.Strings(tests)
	if len(files)+len(tests) == 0 {
		return result, errors.New("package directory contains no Go source files")
	}
	result = GoPackageInfo{Path: filepath.ToSlash(clean), Files: files, TestFiles: tests, HasTests: len(tests) > 0, Imports: []string{}, Structs: []GoStruct{}, Interfaces: []GoInterface{}, Functions: []GoFunction{}, Methods: []GoFunction{}, Types: []GoDeclaration{}, Constants: []GoDeclaration{}, Variables: []GoDeclaration{}}
	seenImports := map[string]bool{}
	for _, name := range append(append([]string{}, files...), tests...) {
		parsed, parseErr := parser.ParseFile(token.NewFileSet(), filepath.Join(canonicalDirectory, name), nil, parser.ParseComments)
		if parseErr != nil {
			return GoPackageInfo{}, fmt.Errorf("parse %s: %w", name, parseErr)
		}
		if result.Package == "" {
			result.Package = parsed.Name.Name
		}
		if !strings.HasSuffix(parsed.Name.Name, "_test") && parsed.Name.Name != result.Package {
			return GoPackageInfo{}, fmt.Errorf("inconsistent production package declarations: %q and %q", result.Package, parsed.Name.Name)
		}
		if strings.HasSuffix(parsed.Name.Name, "_test") && strings.TrimSuffix(parsed.Name.Name, "_test") != result.Package {
			return GoPackageInfo{}, fmt.Errorf("inconsistent external test package declaration: %q", parsed.Name.Name)
		}
		fileInfo, _ := analyzeAST(parsed)
		for _, imp := range fileInfo.Imports {
			seenImports[imp] = true
		}
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		result.Structs = append(result.Structs, fileInfo.Structs...)
		result.Interfaces = append(result.Interfaces, fileInfo.Interfaces...)
		result.Functions = append(result.Functions, fileInfo.Functions...)
		result.Methods = append(result.Methods, fileInfo.Methods...)
		for _, name := range fileInfo.Types {
			result.Types = append(result.Types, GoDeclaration{Name: name, Exported: ast.IsExported(name)})
		}
		for _, name := range fileInfo.Constants {
			result.Constants = append(result.Constants, GoDeclaration{Name: name, Exported: ast.IsExported(name)})
		}
		for _, name := range fileInfo.Variables {
			result.Variables = append(result.Variables, GoDeclaration{Name: name, Exported: ast.IsExported(name)})
		}
	}
	for imp := range seenImports {
		result.Imports = append(result.Imports, imp)
	}
	sort.Strings(result.Imports)
	sort.Slice(result.Structs, func(i, j int) bool { return result.Structs[i].Name < result.Structs[j].Name })
	sort.Slice(result.Interfaces, func(i, j int) bool { return result.Interfaces[i].Name < result.Interfaces[j].Name })
	sort.Slice(result.Functions, func(i, j int) bool { return result.Functions[i].Name < result.Functions[j].Name })
	sort.Slice(result.Methods, func(i, j int) bool { return result.Methods[i].Name < result.Methods[j].Name })
	sort.Slice(result.Types, func(i, j int) bool { return result.Types[i].Name < result.Types[j].Name })
	sort.Slice(result.Constants, func(i, j int) bool { return result.Constants[i].Name < result.Constants[j].Name })
	sort.Slice(result.Variables, func(i, j int) bool { return result.Variables[i].Name < result.Variables[j].Name })
	return result, nil
}
