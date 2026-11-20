package hc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunOnKeepsArgumentsAndRemoteHostSeparate(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "hc-probe")
	log := filepath.Join(dir, "argv")
	script := "#!/bin/sh\nprintf '%s\\000' \"$@\" > \"$AUTOMATION_ARG_LOG\"\nprintf '%s' '{\"address\":\"ivm/t-probe\"}'\n"
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HC_BIN", bin)
	t.Setenv("AUTOMATION_ARG_LOG", log)
	address, err := (Client{}).RunOn("ivm", "/home/me/repo with spaces", map[string]string{"herdr.space": "sp-test"}, []string{"herdr-agent", "nclaude", "--herdr-model", "sonnet", "literal $(text)"})
	if err != nil {
		t.Fatal(err)
	}
	if address != "ivm/t-probe" {
		t.Fatal(address)
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Split(string(raw), "\x00")
	contains := func(want string) bool {
		for _, a := range args {
			if a == want {
				return true
			}
		}
		return false
	}
	for _, want := range []string{"--on", "ivm", "--outlive-parent", "/home/me/repo with spaces", "literal $(text)", "herdr.space=sp-test"} {
		if !contains(want) {
			t.Fatalf("argument %q missing from %q", want, args)
		}
	}
}
