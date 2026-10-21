package prompts

import (
	"strings"
	"testing"
)

func TestBuildGoAPIWorkflow(t *testing.T) {
	s := BuildGoAPIWorkflow(GoAPIWorkflowArgs{ProjectPath: `C:\Projects\my-api`, Task: "Add POST /users"})
	for _, v := range []string{
		`C:\Projects\my-api`,
		"Add POST /users",
		"inspect_go_project",
		"get_project_conventions",
		"suggest_project_config",
		"find_go_symbol",
		"inspect_go_symbol",
		"inspect_go_package",
		"analyze_go_file",
		"review_api_design",
		"run_go_tests",
	} {
		if !strings.Contains(s, v) {
			t.Errorf("missing %q", v)
		}
	}
	if strings.Index(s, "get_project_conventions") > strings.Index(s, "inspect_go_package") || strings.Index(s, "inspect_go_package") > strings.Index(s, "run_go_tests") {
		t.Error("workflow order incorrect")
	}
	if strings.Contains(strings.ToLower(s), "placeholder") || !strings.Contains(s, "not truth") {
		t.Error("prompt safeguards missing")
	}
}
