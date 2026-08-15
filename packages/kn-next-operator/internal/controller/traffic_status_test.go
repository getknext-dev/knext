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
	"testing"

	"k8s.io/utils/ptr"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// mapTrafficStatus is a MIRROR, and this file exists because a test elsewhere assumed
// it was a JUDGE.
//
// The asset-GC e2e leg `lagging status (v3-P5)` pinned `spec.traffic.revisionName` to a
// revision that was never created and then waited for `status.currentTraffic` to go
// EMPTY. It never does. That leg failed 31 consecutive nightly runs and has never passed
// once — it landed the same day the nightly last went green.
//
// The premise is false by construction, not by configuration. In knative serving
// v0.48.0, `pkg/reconciler/route/route.go` assigns `Status.Traffic` in exactly two
// places, both on the success path; an unresolvable target hits `MarkBadTrafficTarget`
// and returns EARLY, before `Status.Traffic` is touched. `service_lifecycle.go` then
// copies the RouteStatusFields into the Service wholesale. So a Service whose pin cannot
// program keeps the LAST SUCCESSFULLY PROGRAMMED traffic — stale, not empty — and there
// is no knob that changes this.
//
// Two states that look alike and are not:
//
//	empty-from-birth   a route that NEVER programmed (the `gc-e2e-pinned` fixture)
//	stale-after-pin    a route that programmed, then got an unresolvable pin
//
// The e2e assumed the second decays into the first. These cases pin the real contract so
// the next person reading `currentTraffic` does not have to re-derive it from a 480s
// timeout in a nightly.
func TestMapTrafficStatus(t *testing.T) {
	t.Run("nil for no targets — the only way currentTraffic goes empty", func(t *testing.T) {
		if got := mapTrafficStatus(nil); got != nil {
			t.Fatalf("mapTrafficStatus(nil) = %v, want nil", got)
		}
		if got := mapTrafficStatus([]servingv1.TrafficTarget{}); got != nil {
			t.Fatalf("mapTrafficStatus([]) = %v, want nil", got)
		}
	})

	t.Run("mirrors a stale split verbatim — it does not judge resolvability", func(t *testing.T) {
		// Exactly the value observed in the failing nightly: the previous 60/40 split,
		// still present while the spec pinned a revision that does not exist.
		stale := []servingv1.TrafficTarget{
			{RevisionName: "gc-e2e-app-00002", Percent: ptr.To(int64(60))},
			{RevisionName: "gc-e2e-app-00003", Percent: ptr.To(int64(40)), LatestRevision: ptr.To(true)},
		}
		got := mapTrafficStatus(stale)
		if len(got) != 2 {
			t.Fatalf("len = %d, want 2 (a stale split must pass through, not be cleared)", len(got))
		}
		if got[0].RevisionName != "gc-e2e-app-00002" || got[0].Percent != 60 {
			t.Errorf("target[0] = %+v, want gc-e2e-app-00002 at 60", got[0])
		}
		if got[1].RevisionName != "gc-e2e-app-00003" || got[1].Percent != 40 || !got[1].LatestRevision {
			t.Errorf("target[1] = %+v, want gc-e2e-app-00003 at 40, latest", got[1])
		}
	})

	t.Run("a nil Percent maps to 0 rather than panicking", func(t *testing.T) {
		got := mapTrafficStatus([]servingv1.TrafficTarget{{RevisionName: "r"}})
		if len(got) != 1 || got[0].Percent != 0 || got[0].LatestRevision {
			t.Fatalf("got %+v, want one target with Percent 0 and LatestRevision false", got)
		}
	})

	t.Run("a nil LatestRevision maps to false", func(t *testing.T) {
		got := mapTrafficStatus([]servingv1.TrafficTarget{
			{RevisionName: "r", Percent: ptr.To(int64(100))},
		})
		if len(got) != 1 || !(!got[0].LatestRevision) {
			t.Fatalf("got %+v, want LatestRevision false", got)
		}
	})
}
