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
	"context"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// A reservation in the rollout limiter means "this app is queued for a
// platform-triggered re-render". The rollout_pending gauge is len(slots), so a
// reservation that outlives the queueing reports a backlog that is not there.
// The live e2e found exactly that: five apps all rendered, and the gauge stayed
// at 2 for minutes until the limiter's 10-minute stale bound swept it.
//
// The leak is any path on which a queued app is next found NOT needing a
// platform re-render and goes on without handing its slot back. These tests pin
// each such path.

// staleNextAppReads serves a frozen NextApp for the next Get of one app: the
// manager's cached client lags the API server by a few milliseconds, and the
// ksvc-update event the operator's own write produces re-enters Reconcile in that
// window.
type staleNextAppReads struct {
	client.Client
	key   types.NamespacedName
	stale *appsv1alpha1.NextApp
}

func (s *staleNextAppReads) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if app, ok := obj.(*appsv1alpha1.NextApp); ok && s.stale != nil && key == s.key {
		stale := s.stale
		s.stale = nil
		stale.DeepCopyInto(app)
		return nil
	}
	return s.Client.Get(ctx, key, obj, opts...)
}

func rolloutSlowestPlatform(h *platformHarness) {
	h.setPlatform(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Rollout = &platformv1alpha1.PlatformRollout{MaxAppsPerMinute: 1}
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "2"}}
	})
}

// The operator's own write of b's Knative Service re-enqueues b. If that pass
// reads b from a cache that has not yet seen the status the previous pass wrote,
// b looks un-rendered and takes a fresh slot; the pass then loses its status
// write to a conflict, and the retry reads b as rendered. The slot it took must
// not survive that.
func TestPlatform_ARenderedAppStopsHoldingASlotAfterAStaleRead(t *testing.T) {
	h := newPlatformHarness(t, appNamed("a", nil), appNamed("b", nil))
	h.reconcile("a")
	h.reconcile("b")
	rolloutSlowestPlatform(h)
	h.reconcile("a") // the free slot
	h.reconcile("b") // queued for the next one
	if got := h.r.rollout.pending(); got != 1 {
		t.Fatalf("setup: %d slot(s) outstanding, want 1 (b)", got)
	}

	frozen := h.app("b") // what a lagging cache would still serve after b renders
	h.now = h.now.Add(61 * time.Second)
	h.reconcile("b") // b's slot is due: it renders and spends the slot
	if got := h.r.rollout.pending(); got != 0 {
		t.Fatalf("setup: %d slot(s) outstanding after b rendered, want 0", got)
	}

	// The re-entry reads the pre-render b.
	h.r.Client = &staleNextAppReads{Client: h.c, key: types.NamespacedName{Namespace: "default", Name: "b"}, stale: frozen}
	_, _ = h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "b"}})
	h.r.Client = h.c

	// The next pass sees the truth: b rendered, nothing is queued.
	h.reconcile("b")
	if got := h.r.rollout.pending(); got != 0 {
		t.Errorf("%d slot(s) still outstanding although every app has rendered: the backlog gauge would report a queue that is not there", got)
	}
}

// The user's own deploy rolls a new revision anyway and bypasses the queue — and
// must hand back the slot it was queued for.
func TestPlatform_AnAppsOwnChangeReleasesItsQueuedSlot(t *testing.T) {
	h := newPlatformHarness(t, appNamed("a", nil), appNamed("b", nil))
	h.reconcile("a")
	h.reconcile("b")
	rolloutSlowestPlatform(h)
	h.reconcile("a")
	h.reconcile("b")
	if got := h.r.rollout.pending(); got != 1 {
		t.Fatalf("setup: %d slot(s) outstanding, want 1 (b)", got)
	}

	b := h.app("b")
	b.Spec.Image = strings.Replace(platformTestImage, "abc123", "fff999", 1)
	b.Generation++
	if err := h.c.Update(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	h.reconcile("b")

	if got := h.r.rollout.pending(); got != 0 {
		t.Errorf("%d slot(s) outstanding after b's own change rendered it", got)
	}
}

// A platform edit that makes a queued app invalid holds it for a different
// reason; it is no longer waiting for a slot.
func TestPlatform_AnAppHeldAsInvalidReleasesItsQueuedSlot(t *testing.T) {
	scaled := func(a *appsv1alpha1.NextApp) {
		a.Spec.Scaling = &appsv1alpha1.ScalingSpec{MaxScale: 8, PoolMax: 10} // 80: exactly the built-in budget
	}
	h := newPlatformHarness(t, appNamed("a", scaled), appNamed("b", scaled))
	h.reconcile("a")
	h.reconcile("b")
	rolloutSlowestPlatform(h)
	h.reconcile("a")
	h.reconcile("b")
	if got := h.r.rollout.pending(); got != 1 {
		t.Fatalf("setup: %d slot(s) outstanding, want 1 (b)", got)
	}

	// The admin lowers the budget below both apps' footprint while b is queued.
	h.setPlatform(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 40}
	})
	h.reconcile("b")

	if c := h.condition("b", ConditionPlatformDefaultsApplied); c == nil || c.Reason != ReasonEffectiveSpecInvalid {
		t.Fatalf("setup: b should now be held as EffectiveSpecInvalid, got %+v", c)
	}
	if got := h.r.rollout.pending(); got != 0 {
		t.Errorf("%d slot(s) outstanding for an app that is no longer queued", got)
	}
}
