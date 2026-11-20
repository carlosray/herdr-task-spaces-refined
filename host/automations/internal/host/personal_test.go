package host

import (
	"fmt"
	"github.com/DnzzL/herdr-automations/internal/config"
	"reflect"
	"strings"
	"testing"
)

func TestNativeAutomationsUseGatewayAwareAdapter(t *testing.T) {
	for _, tool := range []string{"codex", "claude", "nclaude", "pi", "opencode"} {
		t.Run(tool, func(t *testing.T) {
			a := config.Automation{Agent: tool, Model: "provider/model", Prompt: "-literal task"}
			got, err := hcArgv(a)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) < 3 || !reflect.DeepEqual(got[:2], []string{"herdr-agent", tool}) {
				t.Fatalf("unrouted argv %q", got)
			}
			if got[len(got)-1] != " -literal task" {
				t.Fatalf("leading flag prompt unsafe: %q", got)
			}
			if tool == "opencode" && !strings.Contains(strings.Join(got, " "), "--prompt") {
				t.Fatalf("opencode needs --prompt: %q", got)
			}
		})
	}
}

type remoteHC struct {
	fakeHC
	machine string
}

func (f *remoteHC) RunOn(machine, cwd string, labels map[string]string, argv []string) (string, error) {
	f.machine = machine
	f.Run(cwd, labels, argv)
	return machine + "/t7", nil
}
func TestHCProvisionRoutesRemoteExistingSpace(t *testing.T) {
	f := &remoteHC{}
	h := newHCTest(&f.fakeHC)
	h.ops = f
	a := hcAutomation()
	a.Workspace = config.WorkspaceExisting
	a.WorkspaceID = "sp-test"
	a.Machine = "ivm"
	a.Agent = "nclaude"
	s, err := h.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	if f.machine != "ivm" || f.labels["herdr.space"] != "sp-test" || s.PaneID != "ivm/t7" {
		t.Fatalf("remote routing failed: %q %+v %+v", f.machine, f.labels, s)
	}
	if f.labels["agent.tool"] != "nclaude" {
		t.Fatalf("missing native agent metadata: %+v", f.labels)
	}
}

func TestExistingSpaceCannotBeSilentlyRecreatedAfterClosing(t *testing.T) {
	f := &fakeHC{missingSpace: true}
	a := hcAutomation()
	a.Workspace = config.WorkspaceExisting
	a.WorkspaceID = "sp-closed"
	_, err := newHCTest(f).Provision(a)
	if err == nil || !strings.Contains(err.Error(), "no longer exists") || f.argv != nil {
		t.Fatalf("closed Space was launched: err=%v argv=%q", err, f.argv)
	}
}

func TestExistingRemoteSpaceUsesVerifiedAbsoluteLauncher(t *testing.T) {
	f := &remoteHC{}
	h := newHCTest(&f.fakeHC)
	h.ops = f
	a := hcAutomation()
	a.Workspace = config.WorkspaceExisting
	a.WorkspaceID = "sp-known"
	a.Machine = "ivm"
	_, err := h.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	if f.argv[0] != "/verified/ivm/herdr-agent" {
		t.Fatalf("unverified remote executable: %q", f.argv)
	}
}

func TestUnreadableSpaceDocumentFailsClosed(t *testing.T) {
	f := &fakeHC{spaceErr: fmt.Errorf("machine unavailable")}
	a := hcAutomation()
	a.Workspace = config.WorkspaceExisting
	a.WorkspaceID = "sp-known"
	_, err := newHCTest(f).Provision(a)
	if err == nil || f.argv != nil {
		t.Fatalf("unreadable Space document launched: err=%v argv=%q", err, f.argv)
	}
}
