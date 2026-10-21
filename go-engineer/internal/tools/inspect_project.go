package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// GoProjectInfo is the structured result returned by project inspection.
type GoProjectInfo struct {
	Module       string   `json:"module"`
	GoVersion    string   `json:"go_version"`
	Directories  []string `json:"directories"`
	Packages     []string `json:"packages"`
	GoFiles      int      `json:"go_files"`
	TestFiles    int      `json:"test_files"`
	HasTests     bool     `json:"has_tests"`
	Dependencies []string `json:"dependencies"`
}

// InspectGoProject validates and inspects a Go project without modifying it.
func InspectGoProject(ctx context.Context, projectPath string) (GoProjectInfo, error) {
	var info GoProjectInfo

	absolutePath, err := validateProjectPath(projectPath)
	if err != nil {
		return info, err
	}

	module, err := readModuleInfo(ctx, absolutePath)
	if err != nil {
		return info, err
	}
	info.Module = module.Module
	info.GoVersion = module.GoVersion
	info.Dependencies = module.Dependencies
	info.Directories, info.GoFiles, info.TestFiles, err = scanFiles(absolutePath)
	if err != nil {
		return info, fmt.Errorf("scan project files: %w", err)
	}
	info.HasTests = info.TestFiles > 0
	info.Packages, err = listPackages(ctx, absolutePath)
	if err != nil {
		return info, err
	}
	normalizeProjectInfo(&info)
	return info, nil
}

func validateProjectPath(projectPath string) (string, error) {
	if strings.TrimSpace(projectPath) == "" {
		return "", errors.New("project path is required")
	}
	absolutePath := filepath.Clean(projectPath)
	var err error
	if !filepath.IsAbs(absolutePath) {
		absolutePath, err = filepath.Abs(absolutePath)
		if err != nil {
			return "", fmt.Errorf("resolve project path: %w", err)
		}
	}
	fileInfo, err := os.Stat(absolutePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("project path does not exist: %s", projectPath)
		}
		return "", fmt.Errorf("stat project path: %w", err)
	}
	if !fileInfo.IsDir() {
		return "", fmt.Errorf("project path is not a directory: %s", projectPath)
	}
	if _, err := os.Stat(filepath.Join(absolutePath, "go.mod")); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("go.mod not found in project: %s", projectPath)
		}
		return "", fmt.Errorf("check go.mod: %w", err)
	}
	return absolutePath, nil
}

func normalizeProjectInfo(info *GoProjectInfo) {
	if info.Directories == nil {
		info.Directories = []string{}
	}
	if info.Packages == nil {
		info.Packages = []string{}
	}
	if info.Dependencies == nil {
		info.Dependencies = []string{}
	}
}

type moduleInfo struct {
	Module       string
	GoVersion    string
	Dependencies []string
}

type modEditJSON struct {
	Module  struct{ Path string } `json:"Module"`
	Go      string                `json:"Go"`
	Require []struct {
		Path     string `json:"Path"`
		Indirect bool   `json:"Indirect"`
	} `json:"Require"`
}

func readModuleInfo(ctx context.Context, projectPath string) (moduleInfo, error) {
	cmd := exec.CommandContext(ctx, "go", "mod", "edit", "-json")
	cmd.Dir = projectPath
	output, err := cmd.Output()
	if err != nil {
		return moduleInfo{}, fmt.Errorf("read go.mod with go mod edit: %w", err)
	}
	var parsed modEditJSON
	if err := json.Unmarshal(output, &parsed); err != nil {
		return moduleInfo{}, fmt.Errorf("decode go.mod information: %w", err)
	}
	dependencies := make([]string, 0, len(parsed.Require))
	for _, requirement := range parsed.Require {
		if !requirement.Indirect {
			dependencies = append(dependencies, requirement.Path)
		}
	}
	sort.Strings(dependencies)
	return moduleInfo{parsed.Module.Path, parsed.Go, dependencies}, nil
}

func scanFiles(projectPath string) ([]string, int, int, error) {
	directorySet := map[string]bool{}
	goFiles, testFiles := 0, 0
	err := filepath.WalkDir(projectPath, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", "bin", "vendor", ".test-gocache":
				return filepath.SkipDir
			}
			if path != projectPath {
				relative, relativeErr := filepath.Rel(projectPath, path)
				if relativeErr != nil {
					return relativeErr
				}
				directorySet[filepath.ToSlash(relative)] = true
			}
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".go") {
			return nil
		}
		goFiles++
		if strings.HasSuffix(entry.Name(), "_test.go") {
			testFiles++
		}
		return nil
	})
	if err != nil {
		return nil, 0, 0, err
	}
	// Return only top-level directories, as requested by the public result.
	topLevel := map[string]bool{}
	for directory := range directorySet {
		topLevel[strings.Split(directory, "/")[0]] = true
	}
	directories := make([]string, 0, len(topLevel))
	for directory := range topLevel {
		directories = append(directories, directory)
	}
	sort.Strings(directories)
	return directories, goFiles, testFiles, nil
}

func listPackages(ctx context.Context, projectPath string) ([]string, error) {
	cmd := exec.CommandContext(ctx, "go", "list", "-mod=readonly", "-buildvcs=false", "-json", "./...")
	cmd.Dir = projectPath
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("list Go packages: %w: %s", err, strings.TrimSpace(string(output)))
	}
	decoder := json.NewDecoder(strings.NewReader(string(output)))
	var packages []string
	for {
		var pkg struct{ ImportPath string }
		err := decoder.Decode(&pkg)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("decode Go package information: %w", err)
		}
		packages = append(packages, pkg.ImportPath)
	}
	sort.Strings(packages)
	return packages, nil
}
