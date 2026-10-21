package tools

import (
	"context"
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"go-engineer-mcp/internal/config"
)

type ProjectConfigSuggestion struct {
	SuggestedConfig config.ProjectConfig `json:"suggested_config"`
	Evidence        []ConfigEvidence     `json:"evidence"`
	Warnings        []string             `json:"warnings"`
	ExistingConfig  bool                 `json:"existing_config"`
}
type ConfigEvidence struct {
	Setting    string   `json:"setting"`
	Value      string   `json:"value"`
	Confidence string   `json:"confidence"`
	Reasons    []string `json:"reasons"`
}

func SuggestProjectConfig(ctx context.Context, projectPath string) (ProjectConfigSuggestion, error) {
	out := ProjectConfigSuggestion{Evidence: []ConfigEvidence{}, Warnings: []string{}}
	if ctx == nil {
		return out, fmt.Errorf("context is required")
	}
	root, err := validateProjectPath(projectPath)
	if err != nil {
		return out, err
	}
	_, found, err := config.LoadProjectConfigIfExists(root)
	if err != nil {
		return out, err
	}
	out.ExistingConfig = found
	imports := map[string][]string{}
	files := []string{}
	err = filepath.WalkDir(root, func(path string, e os.DirEntry, eerr error) error {
		if eerr != nil {
			return eerr
		}
		if e.IsDir() {
			switch e.Name() {
			case ".git", "bin", "vendor", ".test-gocache":
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(e.Name()) != ".go" || strings.HasSuffix(e.Name(), "_test.go") {
			return nil
		}
		files = append(files, path)
		f, pe := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if pe != nil {
			return fmt.Errorf("parse %s: %w", path, pe)
		}
		rel, _ := filepath.Rel(root, filepath.Dir(path))
		rel = filepath.ToSlash(rel)
		if rel == "." {
			rel = "."
		}
		if _, ok := imports[rel]; !ok {
			imports[rel] = []string{}
		}
		for _, im := range f.Imports {
			imports[rel] = append(imports[rel], strings.Trim(im.Path.Value, `"`))
		}
		return nil
	})
	if err != nil {
		return out, err
	}
	sort.Strings(files)
	chi, gin, echo, stdlib := false, false, false, false
	for _, im := range imports {
		for _, i := range im {
			switch i {
			case "github.com/go-chi/chi/v5":
				chi = true
			case "github.com/gin-gonic/gin":
				gin = true
			case "github.com/labstack/echo/v4":
				echo = true
			case "net/http":
				stdlib = true
			}
		}
	}
	routers := []string{}
	if chi {
		routers = append(routers, "chi")
	}
	if gin {
		routers = append(routers, "gin")
	}
	if echo {
		routers = append(routers, "echo")
	}
	if len(routers) == 0 && stdlib {
		routers = []string{"stdlib"}
	}
	if len(routers) == 1 {
		out.SuggestedConfig.HTTP.Router = routers[0]
		out.Evidence = append(out.Evidence, ConfigEvidence{"http.router", routers[0], "medium", []string{"supported router dependency is imported"}})
	} else if len(routers) > 1 {
		out.Warnings = append(out.Warnings, "multiple supported routers were detected; router was left unspecified")
	}
	for p := range imports {
		base := strings.ToLower(filepath.Base(p))
		if strings.Contains(base, "service") || strings.Contains(base, "application") || strings.Contains(base, "usecase") {
			out.SuggestedConfig.Packages.Services = append(out.SuggestedConfig.Packages.Services, p)
			out.Evidence = append(out.Evidence, ConfigEvidence{"packages.services", p, "medium", []string{"directory name suggests a service or application package"}})
		}
		if strings.Contains(base, "handler") || strings.Contains(base, "http") || strings.Contains(base, "transport") {
			out.SuggestedConfig.Packages.Handlers = append(out.SuggestedConfig.Packages.Handlers, p)
			out.Evidence = append(out.Evidence, ConfigEvidence{"packages.handlers", p, "medium", []string{"directory name suggests an HTTP boundary package"}})
		}
		if strings.Contains(base, "repos") || strings.Contains(base, "store") || strings.Contains(base, "storage") {
			out.SuggestedConfig.Packages.Repositories = append(out.SuggestedConfig.Packages.Repositories, p)
			out.Evidence = append(out.Evidence, ConfigEvidence{"packages.repositories", p, "low", []string{"directory name suggests a persistence package"}})
		}
	}
	if len(out.SuggestedConfig.Packages.Handlers) > 0 && len(out.SuggestedConfig.Packages.Services) > 0 && len(out.SuggestedConfig.Packages.Repositories) > 0 {
		out.SuggestedConfig.Project.Architecture = "layered"
		out.Evidence = append(out.Evidence, ConfigEvidence{"project.architecture", "layered", "medium", []string{"distinct handler, service, and repository package boundaries were found"}})
	}
	out.SuggestedConfig.Version = 1
	out.SuggestedConfig.Testing.DefaultPackage = "./..."
	out.Evidence = append(out.Evidence, ConfigEvidence{"testing.default_package", "./...", "high", []string{"ordinary Go module with repository-wide package discovery"}})
	for _, p := range [][]string{out.SuggestedConfig.Packages.Handlers, out.SuggestedConfig.Packages.Services, out.SuggestedConfig.Packages.Repositories} {
		sort.Strings(p)
	}
	sort.Slice(out.Evidence, func(i, j int) bool {
		return out.Evidence[i].Setting+out.Evidence[i].Value < out.Evidence[j].Setting+out.Evidence[j].Value
	})
	sort.Strings(out.Warnings)
	return out, nil
}
