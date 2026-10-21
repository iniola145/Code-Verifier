package tools

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

const maxTestOutput = 100 * 1024

type GoTestResult struct {
	Success    bool   `json:"success"`
	ExitCode   int    `json:"exit_code"`
	Package    string `json:"package"`
	Output     string `json:"output"`
	DurationMS int64  `json:"duration_ms"`
	Truncated  bool   `json:"truncated"`
}

func RunGoTests(ctx context.Context, projectPath, packagePattern string) (GoTestResult, error) {
	if packagePattern == "" {
		packagePattern = "./..."
	}
	if err := validatePackagePattern(packagePattern); err != nil {
		return GoTestResult{}, err
	}
	absolutePath, err := validateProjectPath(projectPath)
	if err != nil {
		return GoTestResult{}, err
	}

	result := GoTestResult{Package: packagePattern}
	started := time.Now()
	cmd := exec.CommandContext(ctx, "go", "test", packagePattern)
	cmd.Dir = absolutePath
	output := &limitedBuffer{limit: maxTestOutput}
	cmd.Stdout = output
	cmd.Stderr = output
	err = cmd.Run()
	result.DurationMS = time.Since(started).Milliseconds()
	result.Output = output.String()
	result.Truncated = output.truncated
	if err == nil {
		result.Success = true
		return result, nil
	}
	if ctx.Err() != nil {
		return GoTestResult{}, ctx.Err()
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.ExitCode = exitError.ExitCode()
		return result, nil
	}
	return GoTestResult{}, fmt.Errorf("start go test: %w", err)
}

func validatePackagePattern(pattern string) error {
	if strings.TrimSpace(pattern) == "" || strings.HasPrefix(pattern, "-") {
		return errors.New("invalid Go package pattern")
	}
	if strings.IndexFunc(pattern, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\r' || r == '\n' || strings.ContainsRune(";&|<>", r)
	}) >= 0 {
		return errors.New("invalid Go package pattern")
	}
	return nil
}

type limitedBuffer struct {
	data      []byte
	limit     int
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	remaining := b.limit - len(b.data)
	if remaining <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if len(p) > remaining {
		b.data = append(b.data, p[:remaining]...)
		b.truncated = true
		return len(p), nil
	}
	b.data = append(b.data, p...)
	return len(p), nil
}

func (b *limitedBuffer) String() string { return string(b.data) }

var _ io.Writer = (*limitedBuffer)(nil)
