package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfig(t *testing.T) {
	p := t.TempDir()
	write(t, p, "version: 1\nhttp: {router: chi}\npackages: {services: [internal/services]}\n")
	c, ok, e := LoadProjectConfigIfExists(p)
	if e != nil || !ok || c.HTTP.Router != "chi" {
		t.Fatalf("%#v %v %v", c, ok, e)
	}
}
func TestMissing(t *testing.T) {
	_, ok, e := LoadProjectConfigIfExists(t.TempDir())
	if e != nil || ok {
		t.Fatalf("%v %v", ok, e)
	}
}

func TestVersionRequiredAndOnlyOneSupported(t *testing.T) {
	for _, contents := range []string{"version: 0\n", "version: 2\n", "http: {}\n"} {
		p := t.TempDir()
		write(t, p, contents)
		if _, _, err := LoadProjectConfigIfExists(p); err == nil {
			t.Errorf("accepted %q", contents)
		}
	}
}

func TestOptionalBooleans(t *testing.T) {
	for _, test := range []struct {
		contents string
		want     *bool
	}{
		{"version: 1\ndatabase: {}\n", nil},
		{"version: 1\ndatabase: {direct_access_from_handlers: false}\ncontext: {require_propagation: false}\n", boolPtr(false)},
		{"version: 1\ndatabase: {direct_access_from_handlers: true}\n", boolPtr(true)},
	} {
		p := t.TempDir()
		write(t, p, test.contents)
		c, _, err := LoadProjectConfigIfExists(p)
		if err != nil {
			t.Fatal(err)
		}
		if (c.Database.DirectAccessFromHandlers == nil) != (test.want == nil) || test.want != nil && *c.Database.DirectAccessFromHandlers != *test.want {
			t.Errorf("got %#v want %#v", c.Database.DirectAccessFromHandlers, test.want)
		}
	}
}

func boolPtr(v bool) *bool { return &v }
func TestInvalid(t *testing.T) {
	for _, s := range []string{"version: 2", "databse: {}", "packages: {services: [../x]}", "packages: {handlers: [C:/x]}"} {
		p := t.TempDir()
		write(t, p, s)
		if _, _, e := LoadProjectConfigIfExists(p); e == nil {
			t.Errorf("accepted %q", s)
		}
	}
}
func write(t *testing.T, p, s string) {
	t.Helper()
	if e := os.WriteFile(filepath.Join(p, fileName), []byte(s), 0644); e != nil {
		t.Fatal(e)
	}
}
