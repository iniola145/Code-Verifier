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

type TestScaffoldResult struct {
	Package     string   `json:"package"`
	Target      string   `json:"target"`
	Receiver    string   `json:"receiver,omitempty"`
	TestName    string   `json:"test_name"`
	TestCode    string   `json:"test_code"`
	Imports     []string `json:"imports"`
	IsHTTP      bool     `json:"is_http"`
}

func GenerateGoTestScaffold(ctx context.Context, projectPath, filePath, symbol string) (TestScaffoldResult, error) {
	var result TestScaffoldResult
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
	fullPath := filepath.Join(project, clean)
	st, err := os.Stat(fullPath)
	if err != nil || st.IsDir() || filepath.Ext(fullPath) != ".go" {
		return result, fmt.Errorf("valid Go file required: %s", filePath)
	}

	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, fullPath, nil, parser.ParseComments)
	if err != nil {
		return result, fmt.Errorf("parse Go file: %w", err)
	}

	var targetFunc *ast.FuncDecl
	for _, decl := range parsed.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Name.Name == symbol {
			targetFunc = fn
			break
		}
	}

	if targetFunc == nil {
		return result, fmt.Errorf("function or method %q not found in %s", symbol, filePath)
	}

	result.Package = parsed.Name.Name
	result.Target = symbol
	result.TestName = "Test" + strings.Title(symbol)
	if targetFunc.Recv != nil && len(targetFunc.Recv.List) > 0 {
		recvType := exprString(targetFunc.Recv.List[0].Type)
		result.Receiver = recvType
		cleanRecv := strings.TrimPrefix(recvType, "*")
		result.TestName = "Test" + strings.Title(cleanRecv) + "_" + strings.Title(symbol)
	}

	isHTTP := isHTTPHandler(targetFunc)
	result.IsHTTP = isHTTP

	code, imports := buildScaffoldCode(result.Package, targetFunc, result.TestName, isHTTP)
	result.TestCode = code
	result.Imports = imports

	return result, nil
}

func buildScaffoldCode(pkg string, fn *ast.FuncDecl, testName string, isHTTP bool) (string, []string) {
	var buf bytes.Buffer
	importsMap := map[string]bool{"testing": true}

	buf.WriteString(fmt.Sprintf("package %s_test\n\n", pkg))

	if isHTTP {
		importsMap["net/http"] = true
		importsMap["net/http/httptest"] = true
		buf.WriteString("import (\n")
		buf.WriteString("\t\"net/http\"\n")
		buf.WriteString("\t\"net/http/httptest\"\n")
		buf.WriteString("\t\"testing\"\n")
		buf.WriteString(")\n\n")

		buf.WriteString(fmt.Sprintf("func %s(t *testing.T) {\n", testName))
		buf.WriteString("\ttests := []struct {\n")
		buf.WriteString("\t\tname       string\n")
		buf.WriteString("\t\tmethod     string\n")
		buf.WriteString("\t\ttarget     string\n")
		buf.WriteString("\t\twantStatus int\n")
		buf.WriteString("\t}{\n")
		buf.WriteString("\t\t{\n")
		buf.WriteString("\t\t\tname:       \"success\",\n")
		buf.WriteString("\t\t\tmethod:     http.MethodGet,\n")
		buf.WriteString("\t\t\ttarget:     \"/\",\n")
		buf.WriteString("\t\t\twantStatus: http.StatusOK,\n")
		buf.WriteString("\t\t},\n")
		buf.WriteString("\t}\n")
		buf.WriteString("\tfor _, tt := range tests {\n")
		buf.WriteString("\t\tt.Run(tt.name, func(t *testing.T) {\n")
		buf.WriteString("\t\t\treq := httptest.NewRequest(tt.method, tt.target, nil)\n")
		buf.WriteString("\t\t\tw := httptest.NewRecorder()\n\n")
		if fn.Recv != nil {
			buf.WriteString(fmt.Sprintf("\t\t\t// TODO: Initialize receiver\n"))
			buf.WriteString(fmt.Sprintf("\t\t\t// receiver.%s(w, req)\n\n", fn.Name.Name))
		} else {
			buf.WriteString(fmt.Sprintf("\t\t\t// %s(w, req)\n\n", fn.Name.Name))
		}
		buf.WriteString("\t\t\tresp := w.Result()\n")
		buf.WriteString("\t\t\tdefer resp.Body.Close()\n\n")
		buf.WriteString("\t\t\tif resp.StatusCode != tt.wantStatus {\n")
		buf.WriteString("\t\t\t\tt.Errorf(\"status = %v, want %v\", resp.StatusCode, tt.wantStatus)\n")
		buf.WriteString("\t\t\t}\n")
		buf.WriteString("\t\t})\n")
		buf.WriteString("\t}\n")
		buf.WriteString("}\n")
	} else {
		buf.WriteString("import (\n")
		buf.WriteString("\t\"testing\"\n")
		buf.WriteString(")\n\n")

		buf.WriteString(fmt.Sprintf("func %s(t *testing.T) {\n", testName))
		buf.WriteString("\ttests := []struct {\n")
		buf.WriteString("\t\tname    string\n")
		buf.WriteString("\t\twantErr bool\n")
		buf.WriteString("\t}{\n")
		buf.WriteString("\t\t{\n")
		buf.WriteString("\t\t\tname:    \"sample case\",\n")
		buf.WriteString("\t\t\twantErr: false,\n")
		buf.WriteString("\t\t},\n")
		buf.WriteString("\t}\n")
		buf.WriteString("\tfor _, tt := range tests {\n")
		buf.WriteString("\t\tt.Run(tt.name, func(t *testing.T) {\n")
		if fn.Recv != nil {
			buf.WriteString(fmt.Sprintf("\t\t\t// TODO: receiver.%s(...)\n", fn.Name.Name))
		} else {
			buf.WriteString(fmt.Sprintf("\t\t\t// TODO: %s(...)\n", fn.Name.Name))
		}
		buf.WriteString("\t\t})\n")
		buf.WriteString("\t}\n")
		buf.WriteString("}\n")
	}

	formatted, err := format.Source(buf.Bytes())
	if err == nil {
		buf.Reset()
		buf.Write(formatted)
	}

	importsList := make([]string, 0, len(importsMap))
	for imp := range importsMap {
		importsList = append(importsList, imp)
	}

	return buf.String(), importsList
}

