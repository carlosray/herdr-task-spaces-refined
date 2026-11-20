package runner

import (
	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/history"
	"github.com/DnzzL/herdr-automations/internal/host"
	"strings"
	"testing"
)

func TestInactiveAutomationCannotBeManuallyLaunched(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	called := false
	fake := &fakeHost{provision: func(config.Automation) (host.Session, error) { called = true; return host.Session{}, nil }}
	a := automation()
	a.Disabled = true
	err := New(fake).Run(a, history.TriggerManual)
	if err == nil || !strings.Contains(err.Error(), "inactive") || called {
		t.Fatalf("inactive run was not blocked: %v called=%v", err, called)
	}
}
