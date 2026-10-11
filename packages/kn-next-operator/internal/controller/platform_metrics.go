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

	"k8s.io/apimachinery/pkg/types"
)

// heldTracker turns the per-pass platform gate into fleet metrics (ADR-0064).
//
// It OBSERVES the verdict, it never makes one: the hold decision is made by
// platformEffectiveGate / gateRollout and reported to the user by
// computeStatusVerdict. The tracker only remembers which reason each app is
// currently held for, so the held-apps gauge can drop an app the moment it is
// released or deleted, and the holds counter can count a persistent hold once.
//
// State is in memory, like the rollout limiter: after an operator restart the
// gauge refills as each app is reconciled again, and a hold that was already in
// force is counted once more. The zero value is ready to use.
type heldTracker struct {
	mu    sync.Mutex
	byApp map[types.NamespacedName]string
}

// holdReason is the metric label for a gate: the same Reason the app's
// PlatformDefaultsApplied condition carries, or "" when the pass is not held.
func holdReason(g platformGate) string {
	switch g.hold {
	case holdEffectiveSpecInvalid:
		return ReasonEffectiveSpecInvalid
	case holdRolloutPending:
		return ReasonRolloutPending
	default:
		return ""
	}
}

// observe records this pass's gate for app.
func (h *heldTracker) observe(app types.NamespacedName, gate platformGate) {
	reason := holdReason(gate)

	h.mu.Lock()
	defer h.mu.Unlock()

	prev := h.byApp[app]
	if reason == prev {
		return
	}
	if reason == "" {
		delete(h.byApp, app)
	} else {
		if h.byApp == nil {
			h.byApp = map[types.NamespacedName]string{}
		}
		h.byApp[app] = reason
		platformHoldsTotal.WithLabelValues(reason).Inc()
	}
	h.publishLocked()
}

// forget drops app: it was deleted, so whatever hold it was in is over.
func (h *heldTracker) forget(app types.NamespacedName) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, held := h.byApp[app]; !held {
		return
	}
	delete(h.byApp, app)
	h.publishLocked()
}

// publishLocked rewrites the gauge from the current set. Every known reason is
// written, so a reason whose last app left reads 0 rather than going stale.
func (h *heldTracker) publishLocked() {
	counts := map[string]float64{ReasonEffectiveSpecInvalid: 0, ReasonRolloutPending: 0}
	for _, reason := range h.byApp {
		counts[reason]++
	}
	for reason, n := range counts {
		platformHeldApps.WithLabelValues(reason).Set(n)
	}
}
