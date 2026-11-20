package hc

import (
	"os"
	"strings"
	"testing"
)

// Opt-in integration check: reads core metadata and tests adapter executable
// access only. It never starts an agent, changes labels or writes a document.
func TestReadOnlyNativePreflight(t *testing.T) {
	if os.Getenv("HERDR_AUTOMATIONS_VERIFY_NATIVE") != "1" {
		t.Skip("set HERDR_AUTOMATIONS_VERIFY_NATIVE=1 for read-only local+IVM API verification")
	}
	for _, machine := range []string{"", "ivm"} {
		t.Run(machine, func(t *testing.T) {
			path, err := (Client{}).AgentLauncherOn(machine)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasSuffix(path, "/.local/bin/herdr-agent") {
				t.Fatalf("unexpected adapter path %q", path)
			}
			params := map[string]any{"name": "herdr-app"}
			if machine != "" {
				params["on"] = machine
			}
			var doc struct {
				Value struct {
					Spaces []struct {
						ID string `json:"id"`
					} `json:"spaces"`
				} `json:"value"`
			}
			if err := rpc(&doc, "doc.get", params); err != nil {
				t.Fatal(err)
			}
			if len(doc.Value.Spaces) == 0 {
				t.Skip("no Spaces on target core")
			}
			found, err := (Client{}).SpaceExists(machine, doc.Value.Spaces[0].ID)
			if err != nil || !found {
				t.Fatalf("live Space not verified: %v", err)
			}
			found, err = (Client{}).SpaceExists(machine, "sp-automation-nonexistent-preflight-fixture")
			if err != nil || found {
				t.Fatalf("nonexistent Space accepted: %v", err)
			}
		})
	}
}
