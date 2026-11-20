package main

import (
	"bytes"
	"github.com/DnzzL/herdr-automations/internal/config"
	"os"
	"strings"
	"testing"
)

func TestManualArgumentsExpandCopyLiterally(t *testing.T) {
	a := config.Automation{Manual: true, Prompt: `Read {argument name="Granola link"} and {argument name="Granola link"}`}
	value := "$(touch /tmp/nope) `$HOME` $& {argument name=\"Other\"}"
	got, err := applyRunArguments(a, map[string]string{"Granola link": value})
	if err != nil || got.Prompt != "Read "+value+" and "+value {
		t.Fatalf("literal expansion: %q %v", got.Prompt, err)
	}
	if !strings.Contains(a.Prompt, "{argument") {
		t.Fatal("saved template mutated")
	}
}
func TestScheduledArgumentsNeverExpand(t *testing.T) {
	a := config.Automation{Prompt: `{argument name="Link"}`}
	got, err := applyRunArguments(a, nil)
	if err != nil || got.Prompt != a.Prompt {
		t.Fatal("scheduled prompt changed")
	}
	if _, err = applyRunArguments(a, map[string]string{"Link": "value"}); err == nil {
		t.Fatal("scheduled override accepted")
	}
}
func TestArgumentsValidateBeforeLaunch(t *testing.T) {
	for _, tc := range []struct {
		prompt string
		values map[string]string
	}{{`{argument name="Link"}`, nil}, {`{argument name="Link"}`, map[string]string{"Link": " "}}, {`{argument name=""}`, nil}, {`{argument name=Link}`, nil}, {`plain`, map[string]string{"Extra": "value"}}} {
		if _, err := applyRunArguments(config.Automation{Manual: true, Prompt: tc.prompt}, tc.values); err == nil {
			t.Fatalf("invalid arguments accepted: %q", tc.prompt)
		}
	}
}
func TestRunInputIsBoundedStrictJSON(t *testing.T) {
	for _, s := range []string{`null`, `[]`, `{"Link":3}`, `{"Link":"ok"} {}`, strings.Repeat(" ", maxRunInput+1)} {
		if _, err := decodeRunArguments(strings.NewReader(s)); err == nil {
			t.Fatalf("invalid input accepted, length %d", len(s))
		}
	}
	got, err := decodeRunArguments(strings.NewReader(`{"Link":"a\nb"}`))
	if err != nil || got["Link"] != "a\nb" {
		t.Fatalf("decode: %v %v", got, err)
	}
}

func TestSelectedRunPreservesSavedTemplateAndRejectsScheduledInput(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", dir)
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	raw := []byte("backend: hc\nautomations:\n  - name: manual\n    manual: true\n    repo: /src/nebo\n    workspace: existing\n    workspace_id: sp-test\n    agent: codex\n    prompt: 'Read {argument name=\"Link\"}'\n  - name: schedule\n    cron: '@daily'\n    repo: /src/nebo\n    workspace: existing\n    workspace_id: sp-test\n    agent: codex\n    prompt: 'Read {argument name=\"Link\"}'\n")
	if err := os.WriteFile(config.Path(), raw, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := selectedRun("manual", map[string]string{"Link": "literal"})
	if err != nil || got.Prompt != "Read literal" {
		t.Fatalf("manual launch: %+v %v", got, err)
	}
	got, err = selectedRun("schedule", nil)
	if err != nil || got.Prompt != `Read {argument name="Link"}` {
		t.Fatalf("schedule changed: %+v %v", got, err)
	}
	if _, err = selectedRun("schedule", map[string]string{"Link": "literal"}); err == nil {
		t.Fatal("schedule accepted input")
	}
	after, err := os.ReadFile(config.Path())
	if err != nil || !bytes.Equal(raw, after) {
		t.Fatal("template config changed")
	}
	if entries, _ := os.ReadDir(config.StateDir()); len(entries) != 0 {
		t.Fatal("validation unexpectedly wrote state/history")
	}
}
