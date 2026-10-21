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

	"go-engineer-mcp/internal/config"
)

type APIReview struct {
	Package       string          `json:"package"`
	FilesReviewed []string        `json:"files_reviewed"`
	Findings      []ReviewFinding `json:"findings"`
	Summary       ReviewSummary   `json:"summary"`
}
type ReviewFinding struct {
	Rule         string `json:"rule"`
	Category     string `json:"category"`
	Severity     string `json:"severity"`
	File         string `json:"file,omitempty"`
	Function     string `json:"function,omitempty"`
	Description  string `json:"description"`
	Evidence     string `json:"evidence,omitempty"`
	GuidelineURI string `json:"guideline_uri,omitempty"`
	Source       string `json:"source,omitempty"`
}
type ReviewSummary struct {
	FilesReviewed int `json:"files_reviewed"`
	FindingCount  int `json:"finding_count"`
	Errors        int `json:"errors"`
	Warnings      int `json:"warnings"`
	Info          int `json:"info"`
}

func ReviewAPIDesign(ctx context.Context, projectPath, packagePath string) (APIReview, error) {
	review := APIReview{FilesReviewed: []string{}, Findings: []ReviewFinding{}}
	if ctx == nil {
		return review, errors.New("context is required")
	}
	project, err := validateProjectPath(projectPath)
	if err != nil {
		return review, err
	}
	projectConfig, configured, err := config.LoadProjectConfigIfExists(project)
	if err != nil {
		return review, err
	}
	if filepath.IsAbs(packagePath) || strings.TrimSpace(packagePath) == "" {
		return review, errors.New("package path must be a non-empty relative path")
	}
	clean := filepath.Clean(packagePath)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return review, errors.New("package path must remain inside the project")
	}
	dir := filepath.Join(project, clean)
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return review, fmt.Errorf("package directory does not exist: %s", packagePath)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return review, fmt.Errorf("read package directory: %w", err)
	}
	files := []string{}
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".go" {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	if len(files) == 0 {
		return review, errors.New("package directory contains no Go source files")
	}
	review.FilesReviewed = files
	review.Package = strings.TrimSuffix(clean, string(filepath.Separator))
	for _, name := range files {
		parsed, parseErr := parser.ParseFile(token.NewFileSet(), filepath.Join(dir, name), nil, parser.ParseComments)
		if parseErr != nil {
			return APIReview{}, fmt.Errorf("parse %s: %w", name, parseErr)
		}
		if review.Package == "." || review.Package == "" {
			review.Package = parsed.Name.Name
		}
		reviewFile(&review, name, clean, parsed, projectConfig, configured)
	}
	sort.SliceStable(review.Findings, func(i, j int) bool {
		a, b := review.Findings[i], review.Findings[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Function != b.Function {
			return a.Function < b.Function
		}
		return a.Rule < b.Rule
	})
	review.Summary = ReviewSummary{FilesReviewed: len(files), FindingCount: len(review.Findings)}
	for _, f := range review.Findings {
		switch f.Severity {
		case "error":
			review.Summary.Errors++
		case "warning":
			review.Summary.Warnings++
		case "info":
			review.Summary.Info++
		}
	}
	normalizeAPIReview(&review)
	return review, nil
}

func normalizeAPIReview(review *APIReview) {
	if review.FilesReviewed == nil {
		review.FilesReviewed = []string{}
	}
	if review.Findings == nil {
		review.Findings = []ReviewFinding{}
	}
}

func reviewFile(review *APIReview, file, packagePath string, f *ast.File, projectConfig config.ProjectConfig, configured bool) {
	database := false
	for _, i := range f.Imports {
		if strings.Trim(i.Path.Value, `"`) == "database/sql" {
			database = true
		}
	}
	serviceLike := strings.Contains("/"+filepath.ToSlash(packagePath)+"/", "/service/") || strings.Contains("/"+filepath.ToSlash(packagePath)+"/", "/application/")
	if configured && len(projectConfig.Packages.Services) > 0 {
		serviceLike = false
		for _, configuredPath := range projectConfig.Packages.Services {
			if filepath.ToSlash(filepath.Clean(configuredPath)) == filepath.ToSlash(filepath.Clean(packagePath)) {
				serviceLike = true
			}
		}
	}
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		name := fd.Name.Name
		handler := isHTTPHandler(fd)
		hasContext := hasContextParam(fd)
		if serviceLike && functionUsesHTTP(fd) {
			addFinding(review, "service-http-dependency", "layer-boundary", "warning", file, name, "Possible transport concern: service/application code accepts HTTP concepts directly.", "function parameter uses HTTP type", "go://guidelines/services")
		}
		ast.Inspect(fd.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			if database && handler && isDBCall(call) {
				addFinding(review, "handler-direct-db", "handler-boundary", "warning", file, name, "Possible transport concern: handler directly references database operations.", exprString(call), "go://guidelines/handlers")
				if configured && projectConfig.Database.DirectAccessFromHandlers != nil && !*projectConfig.Database.DirectAccessFromHandlers {
					review.Findings[len(review.Findings)-1].Source = "project-convention"
				} else {
					review.Findings[len(review.Findings)-1].Source = "general-guideline"
				}
			}
			if serviceLike && containsHTTPConcept(call) {
				addFinding(review, "service-http-dependency", "layer-boundary", "warning", file, name, "Possible transport concern: service/application code directly uses HTTP concepts.", exprString(call), "go://guidelines/services")
			}
			if hasContext && isContextRoot(call) && (handler || serviceLike) {
				addFinding(review, "context-background-with-existing-context", "context", "warning", file, name, "Possible context propagation concern: an existing context parameter is replaced by a process-root context.", exprString(call), "go://guidelines/context")
			}
			if (handler || serviceLike) && isPanic(call) {
				addFinding(review, "panic-request-path", "error-handling", "warning", file, name, "Possible request-path concern: panic is used in handler/application code.", exprString(call), "go://guidelines/error-handling")
			}
			if isErrorStringClassification(call) {
				addFinding(review, "error-string-classification", "error-handling", "warning", file, name, "Possible error-classification concern: error text is inspected instead of using errors.Is/errors.As.", exprString(call), "go://guidelines/error-handling")
			}
			if database && (isSQLFormatInjection(call) || isSQLConcatenation(call)) {
				addFinding(review, "sql-raw-concatenation", "security", "warning", file, name, "Possible SQL injection concern: SQL query is constructed using dynamic string formatting or concatenation.", exprString(call), "go://guidelines/api-design")
			}
			return true
		})
		if hasHTTPClientCall(fd) && !hasBodyCloseDefer(fd) {
			addFinding(review, "http-response-body-unclosed", "resource-leak", "warning", file, name, "Possible resource leak: HTTP client response body may not be closed via defer resp.Body.Close().", name, "go://guidelines/handlers")
		}
	}
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if path, ok := routeLiteral(call); ok {
			addFinding(review, "rpc-style-route", "api-design", "warning", file, "", "Possible API design concern: route name uses an RPC-style action where resource-oriented routing may fit.", path, "go://guidelines/api-design")
		}
		return true
	})
}

func functionUsesHTTP(f *ast.FuncDecl) bool {
	if f.Type.Params == nil {
		return false
	}
	for _, p := range f.Type.Params.List {
		s := exprString(p.Type)
		if strings.Contains(s, "http.ResponseWriter") || strings.Contains(s, "*http.Request") {
			return true
		}
	}
	return false
}

func addFinding(r *APIReview, rule, cat, sev, file, fn, desc, evidence, guideline string) {
	r.Findings = append(r.Findings, ReviewFinding{Rule: rule, Category: cat, Severity: sev, File: file, Function: fn, Description: desc, Evidence: evidence, GuidelineURI: guideline})
}
func isHTTPHandler(f *ast.FuncDecl) bool {
	if f.Type.Params == nil {
		return false
	}
	for _, p := range f.Type.Params.List {
		s := exprString(p.Type)
		if strings.Contains(s, "http.ResponseWriter") || strings.Contains(s, "*http.Request") {
			return true
		}
	}
	return false
}
func hasContextParam(f *ast.FuncDecl) bool {
	if f.Type.Params == nil {
		return false
	}
	for _, p := range f.Type.Params.List {
		if exprString(p.Type) == "context.Context" {
			return true
		}
	}
	return false
}
func isDBCall(c *ast.CallExpr) bool {
	s := exprString(c.Fun)
	return strings.HasPrefix(s, "sql.") || strings.Contains(s, ".Query") || strings.Contains(s, ".Exec") || strings.Contains(s, ".Begin")
}
func containsHTTPConcept(c *ast.CallExpr) bool {
	s := exprString(c)
	return strings.Contains(s, "http.ResponseWriter") || strings.Contains(s, "*http.Request") || strings.Contains(s, "http.Status")
}
func isContextRoot(c *ast.CallExpr) bool {
	s := exprString(c.Fun)
	return s == "context.Background" || s == "context.TODO"
}
func isPanic(c *ast.CallExpr) bool { return exprString(c.Fun) == "panic" }
func isErrorStringClassification(c *ast.CallExpr) bool {
	s := exprString(c)
	return strings.Contains(s, "err.Error() ==") || strings.Contains(s, "strings.Contains(err.Error()")
}
func isSQLFormatInjection(c *ast.CallExpr) bool {
	s := exprString(c.Fun)
	if s == "fmt.Sprintf" {
		if len(c.Args) > 0 {
			if lit, ok := c.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
				val := strings.ToUpper(lit.Value)
				return strings.Contains(val, "SELECT ") || strings.Contains(val, "INSERT ") || strings.Contains(val, "UPDATE ") || strings.Contains(val, "DELETE ")
			}
		}
	}
	return false
}
func isSQLConcatenation(c *ast.CallExpr) bool {
	s := exprString(c.Fun)
	if strings.Contains(s, ".Query") || strings.Contains(s, ".Exec") {
		for _, arg := range c.Args {
			if b, ok := arg.(*ast.BinaryExpr); ok && b.Op == token.ADD {
				return true
			}
		}
	}
	return false
}
func hasHTTPClientCall(f *ast.FuncDecl) bool {
	found := false
	ast.Inspect(f.Body, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			s := exprString(call.Fun)
			if s == "http.Get" || s == "http.Post" || strings.Contains(s, ".Do(") || strings.HasSuffix(s, ".Do") {
				found = true
				return false
			}
		}
		return true
	})
	return found
}
func hasBodyCloseDefer(f *ast.FuncDecl) bool {
	found := false
	ast.Inspect(f.Body, func(n ast.Node) bool {
		if def, ok := n.(*ast.DeferStmt); ok {
			s := exprString(def.Call)
			if strings.Contains(s, ".Body.Close()") {
				found = true
				return false
			}
		}
		return true
	})
	return found
}
func routeLiteral(c *ast.CallExpr) (string, bool) {
	s := exprString(c.Fun)
	if !(strings.HasSuffix(s, ".GET") || strings.HasSuffix(s, ".POST") || strings.HasSuffix(s, ".PUT") || strings.HasSuffix(s, ".PATCH") || strings.HasSuffix(s, ".DELETE") || strings.HasSuffix(s, ".Handle")) {
		return "", false
	}
	if len(c.Args) == 0 {
		return "", false
	}
	lit, ok := c.Args[0].(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", false
	}
	path := strings.Trim(lit.Value, `"`)
	base := strings.TrimPrefix(path, "/")
	for _, p := range []string{"create", "get", "update", "delete"} {
		if strings.HasPrefix(strings.ToLower(base), p) {
			return path, true
		}
	}
	return "", false
}
