package guidelines

import (
	"strings"
	"testing"
)

func TestAllGuidelines(t *testing.T) {
	items := All()
	if len(items) != 7 {
		t.Fatalf("got %d guidelines, want 7", len(items))
	}
	seen := map[string]bool{}
	for _, item := range items {
		if item.URI == "" || item.Name == "" || item.Content == "" {
			t.Errorf("incomplete guideline: %#v", item)
		}
		if seen[item.URI] {
			t.Errorf("duplicate URI: %s", item.URI)
		}
		seen[item.URI] = true
		if strings.Contains(strings.ToLower(item.Content), "todo") || strings.Contains(strings.ToLower(item.Content), "placeholder") {
			t.Errorf("placeholder in %s", item.URI)
		}
	}
}
