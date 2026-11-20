package schedule

import (
	"github.com/DnzzL/herdr-automations/internal/config"
	"testing"
	"time"
)

func TestManualEntriesNeverBecomeScheduledEvenWithLegacyCron(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	a := config.Automation{Name: "manual", Manual: true, Cron: "* * * * *", CatchUpMinutes: 120}
	cfg := &config.Config{Automations: []config.Automation{a}}
	res := Plan(cfg, State{LastOccurrence: map[string]time.Time{"manual": now.Add(-time.Hour)}}, now)
	if len(res.Decisions) > 0 {
		t.Fatalf("manual entry scheduled: %+v", res.Decisions)
	}
	cfg.Automations = append(cfg.Automations, config.Automation{Name: "daily", Cron: "* * * * *"})
	if len(Collisions(cfg, now)) != 0 {
		t.Fatal("manual entry included in collisions")
	}
}

func TestSwitchingToManualDropsScheduledCursor(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	cfg := &config.Config{Automations: []config.Automation{{Name: "review", Manual: true, Cron: "* * * * *"}}}
	res := Plan(cfg, State{LastOccurrence: map[string]time.Time{"review": now.Add(-time.Hour)}}, now)
	if _, ok := res.State.LastOccurrence["review"]; ok {
		t.Fatal("manual entry kept schedule cursor, would backfill manual time after switching back")
	}
}
