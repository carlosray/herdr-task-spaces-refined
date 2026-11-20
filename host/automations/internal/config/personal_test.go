package config

import "testing"

func TestManualAutomationNeedsNoCronAndAcceptsGatewayClaude(t *testing.T) {
	withConfig(t, `backend: hc
automations:
  - name: duty-helper
    manual: true
    repo: /src/nebo
    workspace: existing
    workspace_id: sp-test
    agent: nclaude
    model: sonnet
    prompt: Investigate
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 0 || len(cfg.Automations) != 1 {
		t.Fatalf("manual entry rejected: %+v", cfg.Invalid)
	}
}

func TestRemoteSpaceAcceptsOpenCode(t *testing.T) {
	withConfig(t, `backend: hc
automations:
  - name: remote-review
    cron: '@daily'
    repo: /home/me/ivm-nebo
    machine: ivm
    workspace: existing
    workspace_id: sp-test
    agent: opencode
    prompt: Review
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 0 || len(cfg.Automations) != 1 {
		t.Fatalf("remote opencode rejected: %+v", cfg.Invalid)
	}
}
