/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/types"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/defaults"
)

// rolloutLimiter paces platform-triggered re-renders (ADR-0064 failure mode F2).
//
// A platform edit can change the effective values of every inheriting app at
// once. Each changed Knative Service template is a new revision, and a new
// revision boots a pod (initial-scale 1). Without a limiter one edit on a
// cluster of N apps starts N pods in the same second.
//
// It hands out SLOTS spaced 60/maxAppsPerMinute seconds apart. An app that
// reserves is told how long until its slot and is expected back then; coming
// back at (or after) the slot passes it through exactly once. Contrast a token
// bucket, whose losers must re-poll: N held apps would each reconcile every few
// seconds for the whole rollout, O(N^2) work for a limiter whose job is to
// reduce load.
//
// Idle time does NOT bank capacity. After a quiet hour the next wave is still
// spaced, not released together — the cap is on re-renders per minute, not an
// average over a day.
//
// The zero value is ready to use. State is in memory only: an operator restart
// forgets the reservations, so a restart mid-rollout re-spaces the remaining
// apps from scratch. That is bounded (still at most maxAppsPerMinute from that
// instant) and is the same trade the warm-schedule requeue makes.
type rolloutLimiter struct {
	mu sync.Mutex
	// last is the latest slot handed out (zero before the first).
	last time.Time
	// slots are outstanding reservations by app.
	slots map[types.NamespacedName]time.Time
}

// staleReservationAfter bounds how long a reservation survives its slot. An app
// deleted while it waited never returns, and without a bound its entry would
// leak for the life of the process.
const staleReservationAfter = 10 * time.Minute

// reserve returns how long until app may re-render: 0 means now. perMinute <= 0
// means the built-in rate.
func (l *rolloutLimiter) reserve(app types.NamespacedName, now time.Time, perMinute int) time.Duration {
	if perMinute <= 0 {
		perMinute = defaults.MaxAppsPerMinute
	}
	interval := time.Minute / time.Duration(perMinute)

	l.mu.Lock()
	defer l.mu.Unlock()

	for k, slot := range l.slots {
		if now.Sub(slot) > staleReservationAfter {
			delete(l.slots, k)
		}
	}

	// The backlog gauge is refreshed on every exit, once the slot map has settled.
	defer func() { rolloutPending.Set(float64(len(l.slots))) }()

	// Returning at (or after) a slot we handed out spends it.
	if slot, held := l.slots[app]; held {
		if !now.Before(slot) {
			delete(l.slots, app)
			return 0
		}
		return slot.Sub(now)
	}

	slot := now
	if next := l.last.Add(interval); !l.last.IsZero() && next.After(now) {
		slot = next
	}
	l.last = slot
	if !slot.After(now) {
		return 0
	}
	if l.slots == nil {
		l.slots = map[types.NamespacedName]time.Time{}
	}
	l.slots[app] = slot
	rolloutWaitSeconds.Observe(slot.Sub(now).Seconds())
	return slot.Sub(now)
}

// release drops app's outstanding reservation, if any, and refreshes the backlog
// gauge. A deleted app never returns for its slot; without this its entry would
// keep rollout_pending raised until an unrelated app next called reserve.
func (l *rolloutLimiter) release(app types.NamespacedName) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.slots, app)
	rolloutPending.Set(float64(len(l.slots)))
}

// pending reports how many reservations are outstanding (tests, and the
// stale-entry bound).
func (l *rolloutLimiter) pending() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.slots)
}
