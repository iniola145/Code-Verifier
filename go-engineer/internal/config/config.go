package config

import (
	"errors"
	"fmt"
	"gopkg.in/yaml.v3"
	"os"
	"path/filepath"
	"strings"
)

const fileName = ".go-engineer.yaml"

type ProjectConfig struct {
	Version  int              `yaml:"version"`
	Project  ProjectSettings  `yaml:"project"`
	HTTP     HTTPSettings     `yaml:"http"`
	Packages PackageSettings  `yaml:"packages"`
	Database DatabaseSettings `yaml:"database"`
	Errors   ErrorSettings    `yaml:"errors"`
	Context  ContextSettings  `yaml:"context"`
	Testing  TestingSettings  `yaml:"testing"`
}
type ProjectSettings struct {
	Architecture string `yaml:"architecture"`
}
type HTTPSettings struct {
	Router string `yaml:"router"`
}
type PackageSettings struct {
	Handlers     []string `yaml:"handlers"`
	Services     []string `yaml:"services"`
	Repositories []string `yaml:"repositories"`
}
type DatabaseSettings struct {
	DirectAccessFromHandlers *bool `yaml:"direct_access_from_handlers"`
}
type ErrorSettings struct {
	Classification string `yaml:"classification"`
}
type ContextSettings struct {
	RequirePropagation *bool `yaml:"require_propagation"`
}
type TestingSettings struct {
	DefaultPackage string `yaml:"default_package"`
}

func LoadProjectConfig(p string) (ProjectConfig, error) {
	c, _, e := LoadProjectConfigIfExists(p)
	return c, e
}
func LoadProjectConfigIfExists(p string) (ProjectConfig, bool, error) {
	if strings.TrimSpace(p) == "" {
		return ProjectConfig{}, false, errors.New("project path is required")
	}
	root, e := filepath.Abs(p)
	if e != nil {
		return ProjectConfig{}, false, e
	}
	st, e := os.Stat(root)
	if e != nil {
		return ProjectConfig{}, false, e
	}
	if !st.IsDir() {
		return ProjectConfig{}, false, errors.New("project path is not a directory")
	}
	data, e := os.ReadFile(filepath.Join(root, fileName))
	if errors.Is(e, os.ErrNotExist) {
		return ProjectConfig{}, false, nil
	}
	if e != nil {
		return ProjectConfig{}, false, e
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return ProjectConfig{}, true, fmt.Errorf("parse %s: %w", fileName, err)
	}
	if !hasVersion(document) {
		return ProjectConfig{}, true, errors.New("configuration version is required")
	}
	var c ProjectConfig
	d := yaml.NewDecoder(strings.NewReader(string(data)))
	d.KnownFields(true)
	if e = d.Decode(&c); e != nil {
		return ProjectConfig{}, true, fmt.Errorf("parse %s: %w", fileName, e)
	}
	if e = validate(c); e != nil {
		return ProjectConfig{}, true, e
	}
	return c, true, nil
}
func validate(c ProjectConfig) error {
	if c.Version != 1 {
		return fmt.Errorf("unsupported configuration version: %d", c.Version)
	}
	if a := c.Project.Architecture; a != "" && a != "layered" && a != "clean" && a != "hexagonal" {
		return fmt.Errorf("unsupported architecture: %s", a)
	}
	if r := c.HTTP.Router; r != "" && r != "chi" && r != "gin" && r != "echo" && r != "stdlib" {
		return fmt.Errorf("unsupported router: %s", r)
	}
	if e := c.Errors.Classification; e != "" && e != "errors-is-as" {
		return fmt.Errorf("unsupported error classification: %s", e)
	}
	for _, group := range [][]string{c.Packages.Handlers, c.Packages.Services, c.Packages.Repositories} {
		for _, p := range group {
			if err := validatePackagePath(p); err != nil {
				return err
			}
		}
	}
	if p := c.Testing.DefaultPackage; p != "" && (strings.HasPrefix(p, "-") || strings.ContainsAny(p, " \t\r\n;&|<>")) {
		return errors.New("invalid testing default package")
	}
	return nil
}

func hasVersion(document yaml.Node) bool {
	if len(document.Content) == 0 {
		return false
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == "version" {
			return true
		}
	}
	return false
}
func validatePackagePath(p string) error {
	if strings.TrimSpace(p) == "" || filepath.IsAbs(p) {
		return fmt.Errorf("invalid configured package path: %q", p)
	}
	c := filepath.Clean(p)
	if c == ".." || strings.HasPrefix(c, ".."+string(filepath.Separator)) {
		return fmt.Errorf("configured package path escapes project: %q", p)
	}
	return nil
}
