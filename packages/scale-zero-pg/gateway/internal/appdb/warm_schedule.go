package appdb

import (
	"fmt"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

// Scheduled warm-window evaluation (knext #388, ADR-0030 addendum). This is a
// deliberate SEMANTIC PORT of the knext operator's warmScheduleFloor
// (packages/kn-next-operator/internal/controller/nextapp_controller.go): same
// 5-field cron parser (robfig/cron ParseStandard — the flavour the Kubernetes
// CronJob controller uses), same per-window IANA timezone (empty => UTC), same
// membership rule — a window is ACTIVE at `now` iff its next `end` fire is
// sooner than its next `start` fire (i.e. we are between a start and its end).
//
// The parity is the lockstep: the owner declares the SAME windows on the
// NextApp (pod floor) and on the AppDatabase (this DB warm hold); both
// operators evaluate them against cluster-synchronized clocks, so the two
// halves of the pre-warm flip together (bounded skew — see reconcile.go: this
// side evaluates on the resync tick, default 15s). The test table in
// warm_schedule_test.go is a port of the knext one (including the #394 DST
// characterization cases) so a semantic drift on either side breaks loudly.
//
// Divergence BY DESIGN: no `replicas` and no boundary computation. A Neon
// compute is single-writer, so warm is binary; and this controller reconciles
// every CR on a short resync tick (APPDB_RESYNC_MS, default 15s), which IS the
// boundary requeue — no per-CR RequeueAfter machinery like controller-runtime's.

// warmWindowActive reports whether the single window w contains `now`, in the
// window's own timezone. An error is returned for an unparseable cron or an
// unknown timezone — there is no admission webhook on this CRD, so the caller
// surfaces a bad window loudly (Warning event + condition) instead of skipping
// it silently.
func warmWindowActive(w WarmWindow, now time.Time) (bool, error) {
	tz := w.Timezone
	if tz == "" {
		tz = "UTC"
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return false, fmt.Errorf("unknown timezone %q", w.Timezone)
	}
	startSched, err := cron.ParseStandard(strings.TrimSpace(w.Start))
	if err != nil {
		return false, fmt.Errorf("start %q is not valid 5-field cron: %w", w.Start, err)
	}
	endSched, err := cron.ParseStandard(strings.TrimSpace(w.End))
	if err != nil {
		return false, fmt.Errorf("end %q is not valid 5-field cron: %w", w.End, err)
	}
	nowTZ := now.In(loc)
	nextStart := startSched.Next(nowTZ)
	nextEnd := endSched.Next(nowTZ)
	// Active iff the pending end comes before the pending start (we're inside a
	// window). At the exact start instant, Next(now) returns the FOLLOWING start
	// while nextEnd is this window's end => active.
	return nextEnd.Before(nextStart), nil
}

// warmScheduleActive evaluates a whole schedule: active is true iff ANY valid
// window contains `now`; invalid lists the windows that failed to parse (for
// loud surfacing — they never hold the compute warm).
func warmScheduleActive(ws []WarmWindow, now time.Time) (active bool, invalid []WarmWindow) {
	for _, w := range ws {
		on, err := warmWindowActive(w, now)
		if err != nil {
			invalid = append(invalid, w)
			continue
		}
		if on {
			active = true
		}
	}
	return active, invalid
}
