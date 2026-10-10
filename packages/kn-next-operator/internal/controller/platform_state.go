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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/defaults"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// Platform-layer reconcile support (ADR-0064): loading the KnextPlatform, the
// per-app gate that sits between spec validation and the Knative Service write,
// and the state the pure status verdict consumes. The merge itself is in
// platform_defaults.go; the pacing in platform_rollout.go.

// ConditionPlatformDefaultsApplied reports whether the cluster platform's
// defaults were merged into this app's last render (ADR-0064 D2). It is computed
// in computeStatusVerdict, never as a branch in Reconcile (architecture.md §4).
const ConditionPlatformDefaultsApplied = "PlatformDefaultsApplied"

// PlatformDefaultsApplied reasons.
const (
	// ReasonNoPlatformCRD: the KnextPlatform CRD is not installed. The operator
	// still starts and behaves exactly as before the platform layer existed.
	ReasonNoPlatformCRD = "NoPlatformCRD"
	// ReasonNoPlatform: the CRD exists but there is no object named default.
	ReasonNoPlatform = "NoPlatform"
	// ReasonInherited: the platform supplied at least one value this app left unset.
	ReasonInherited = "Inherited"
	// ReasonNothingToInherit: a platform is in force but supplies nothing this app
	// leaves unset (an empty platform, or an app that sets every field itself).
	ReasonNothingToInherit = "NothingToInherit"
	// ReasonPlatformNotAccepted: the platform failed the operator's own validation
	// and is IGNORED — built-in defaults apply.
	ReasonPlatformNotAccepted = "PlatformNotAccepted"
	// ReasonEffectiveSpecInvalid: the merge would make this app's spec invalid
	// (e.g. a lowered connection budget). The current Knative Service is held.
	ReasonEffectiveSpecInvalid = "EffectiveSpecInvalid"
	// ReasonRolloutPending: a platform change is queued for this app behind
	// rollout.maxAppsPerMinute; its Knative Service is unchanged until its slot.
	ReasonRolloutPending = "RolloutPending"
)

// platformSnapshot is the platform state one reconcile pass works from.
type platformSnapshot struct {
	// crdPresent: the KnextPlatform kind is served by the cluster.
	crdPresent bool
	// obj is the object named "default"; nil when absent.
	obj *platformv1alpha1.KnextPlatform
	// acceptErr is non-nil when obj exists but failed validation.
	acceptErr error
}

// active returns the platform spec that is merged: nil unless the object exists
// AND was accepted. A platform that is not accepted contributes nothing.
func (p platformSnapshot) active() *platformv1alpha1.KnextPlatformSpec {
	if p.obj == nil || p.acceptErr != nil {
		return nil
	}
	return &p.obj.Spec
}

// hash is the stamp of the platform configuration in force: "" when none is.
func (p platformSnapshot) hash() string {
	if spec := p.active(); spec != nil {
		return platformSpecHash(spec)
	}
	return ""
}

// profile is the effective profile name of the platform in force.
func (p platformSnapshot) profile() string {
	if spec := p.active(); spec != nil && spec.Profile != "" {
		return spec.Profile
	}
	if p.active() != nil {
		return platformv1alpha1.ProfileDefault
	}
	return ""
}

// maxAppsPerMinute is the pacing rate in force.
func (p platformSnapshot) maxAppsPerMinute() int {
	if spec := p.active(); spec != nil && spec.Rollout != nil && spec.Rollout.MaxAppsPerMinute > 0 {
		return int(spec.Rollout.MaxAppsPerMinute)
	}
	return defaults.MaxAppsPerMinute
}

// loadPlatform reads the singleton KnextPlatform. It never fails the pass for a
// missing CRD or object — those are the "built-in defaults" cases — only for a
// real API error.
func (r *NextAppReconciler) loadPlatform(ctx context.Context) (platformSnapshot, error) {
	if !r.PlatformCRDPresent {
		return platformSnapshot{}, nil
	}
	obj := &platformv1alpha1.KnextPlatform{}
	err := r.Get(ctx, client.ObjectKey{Name: platformv1alpha1.SingletonName}, obj)
	switch {
	case err == nil:
	case errors.IsNotFound(err):
		return platformSnapshot{crdPresent: true}, nil
	case apimeta.IsNoMatchError(err) || runtime.IsNotRegisteredError(err):
		// The CRD was removed after start-up, or this scheme never knew the kind.
		// Either way there is nothing to merge; do not fail the app for it.
		return platformSnapshot{}, nil
	default:
		return platformSnapshot{}, err
	}
	return platformSnapshot{
		crdPresent: true,
		obj:        obj,
		acceptErr:  validation.ValidatePlatformSpec(&obj.Spec),
	}, nil
}

// platformResourcePath maps a NextApp resources path to the platform field that
// supplies it: spec.resources.cpuLimit -> spec.resources.defaults.cpuLimit.
func platformResourcePath(appPath string) string {
	return strings.Replace(appPath, "spec.resources.", "spec.resources.defaults.", 1)
}

// platformHold says why a pass is not writing the Knative Service.
type platformHold int

const (
	holdNone platformHold = iota
	// holdEffectiveSpecInvalid: the merged spec is invalid; the live Knative
	// Service is left exactly as it is (ADR-0064 F3, hold-last-good).
	holdEffectiveSpecInvalid
	// holdRolloutPending: the app's re-render is queued behind the rollout limiter.
	holdRolloutPending
)

// platformGate is the outcome of the platform checks between spec validation and
// the Knative Service write.
type platformGate struct {
	hold platformHold
	// field names the spec path blamed (holdEffectiveSpecInvalid).
	field string
	// detail is the underlying validation message.
	detail string
	// wait is how long until this app's slot (holdRolloutPending).
	wait time.Duration
}

// platformEffectiveGate holds an app whose MERGED spec is invalid because of a
// platform value. It is the platform's doing only when the spec is valid under
// the built-in values and the offending value came from the platform; anything
// the app got wrong on its own is not held here and goes down the ordinary
// InvalidSpec path.
func platformEffectiveGate(app *appsv1alpha1.NextApp, snap platformSnapshot, eff effectiveValues) platformGate {
	if snap.active() == nil {
		return platformGate{}
	}
	// The connection wall under the platform's budget. An app that is invalid for
	// ANY other reason is not the platform's to hold: the ordinary InvalidSpec
	// path rejects it.
	if baseErr := validation.ValidateNextAppSpecWithBudget(&app.Spec, eff.connectionBudget); baseErr != nil {
		if eff.connectionBudget != defaults.ConnectionBudget &&
			validation.ValidateNextAppSpecWithBudget(&app.Spec, defaults.ConnectionBudget) == nil {
			return platformGate{hold: holdEffectiveSpecInvalid, field: "spec.scaling", detail: baseErr.Error()}
		}
		return platformGate{}
	}
	// request <= limit across the merged resources, but only when the platform
	// supplied at least one of the four: where no platform value is involved the
	// per-layer validation (or its long-standing absence) already decided, and
	// this must not change that.
	involved := false
	for _, f := range []effectiveString{eff.cpuRequest, eff.cpuLimit, eff.memoryRequest, eff.memoryLimit} {
		involved = involved || f.src == sourcePlatform
	}
	if involved {
		if field, err := validation.ValidateEffectiveResources(
			eff.cpuRequest.value, eff.cpuLimit.value, eff.memoryRequest.value, eff.memoryLimit.value); err != nil {
			return platformGate{hold: holdEffectiveSpecInvalid, field: "spec.resources." + field, detail: err.Error()}
		}
	}
	return platformGate{}
}

// effectiveHash fingerprints the merged values that reach the rendered Knative
// Service. Comparing it with what the app was last rendered with answers "would
// this platform change alter the revision template?" without diffing a live
// Service, whose Knative-defaulted fields would differ from a fresh render on
// every pass whether or not anything the platform controls had moved.
func effectiveHash(eff effectiveValues) string {
	raw, err := json.Marshal(struct {
		CC                               int64
		CPUReq, MemReq, CPULim, MemLim   string
		Timeout                          int64
		SDD                              string
		TBC, PanicWindow, PanicThreshold *int32
	}{
		eff.containerConcurrency,
		eff.cpuRequest.value, eff.memoryRequest.value, eff.cpuLimit.value, eff.memoryLimit.value,
		eff.timeoutSeconds,
		eff.scaleDownDelay,
		eff.targetBurstCapacity, eff.panicWindowPercentage, eff.panicThresholdPercentage,
	})
	if err != nil {
		raw = []byte(fmt.Sprintf("%+v", eff))
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}

// appTriggered reports whether the app's own spec changed since the last pass.
// Such a pass rolls a new revision anyway, so the platform's values ride along
// in it for free and the pass is not a platform-triggered re-render.
func appTriggered(app *appsv1alpha1.NextApp) bool {
	cond := apimeta.FindStatusCondition(app.Status.Conditions, ConditionReconciling)
	return cond == nil || cond.ObservedGeneration != app.Generation
}

// gateRollout decides whether this pass may write the Knative Service now or must
// wait for its slot behind the rollout limiter (ADR-0064 F2). It only ever
// returns holdRolloutPending for a PLATFORM-triggered change:
//
//   - nothing platform-side moved since this app was last rendered, or
//   - the move leaves every value the platform controls unchanged for this app
//     (it renders no new revision), or
//   - the app's own spec changed (that pass rolls a new revision regardless), or
//   - the app has no Knative Service yet (nothing to roll),
//
// are all "go now". The first of those is the whole story for a cluster with no
// KnextPlatform: no stamp ever differs, so the limiter is never consulted and
// the pass is exactly the pre-platform one.
func (r *NextAppReconciler) gateRollout(ctx context.Context, app *appsv1alpha1.NextApp, snap platformSnapshot, eff effectiveValues) (platformGate, error) {
	wantSpecHash := snap.hash()
	appliedSpecHash, appliedEffHash := "", effectiveHash(resolveEffective(app, nil))
	if p := app.Status.Platform; p != nil {
		appliedSpecHash, appliedEffHash = p.SpecHash, p.EffectiveHash
	}
	if wantSpecHash == appliedSpecHash {
		return platformGate{}, nil
	}
	if effectiveHash(eff) == appliedEffHash {
		return platformGate{}, nil
	}
	if appTriggered(app) {
		return platformGate{}, nil
	}
	live := &servingv1.Service{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: app.Namespace, Name: app.Name}, live); err != nil {
		if errors.IsNotFound(err) {
			return platformGate{}, nil
		}
		return platformGate{}, err
	}
	key := types.NamespacedName{Namespace: app.Namespace, Name: app.Name}
	if wait := r.rollout.reserve(key, r.now(), snap.maxAppsPerMinute()); wait > 0 {
		return platformGate{hold: holdRolloutPending, wait: wait}, nil
	}
	return platformGate{}, nil
}

// platformDefaultsState is everything the pure verdict needs to compute the
// PlatformDefaultsApplied condition.
type platformDefaultsState struct {
	crdMissing  bool
	present     bool
	notAccepted string
	generation  int64
	profile     string
	inherited   []string
	perMinute   int
	gate        platformGate
}

func newPlatformDefaultsState(snap platformSnapshot, eff effectiveValues, gate platformGate) platformDefaultsState {
	st := platformDefaultsState{
		crdMissing: !snap.crdPresent,
		present:    snap.obj != nil,
		inherited:  eff.inherited,
		perMinute:  snap.maxAppsPerMinute(),
		gate:       gate,
	}
	if snap.obj != nil {
		st.generation = snap.obj.Generation
		st.profile = snap.profile()
		if snap.acceptErr != nil {
			st.notAccepted = snap.acceptErr.Error()
			st.profile = ""
		}
	}
	return st
}

// platformStatusFor builds status.platform for a pass that WROTE the Knative
// Service (or had nothing to write). nil when no platform is in force, so a
// cluster that has not opted in carries no platform status at all.
func platformStatusFor(snap platformSnapshot, eff effectiveValues) *appsv1alpha1.NextAppPlatformStatus {
	if snap.active() == nil {
		return nil
	}
	inherited := append([]string(nil), eff.inherited...)
	return &appsv1alpha1.NextAppPlatformStatus{
		ObservedGeneration: snap.obj.Generation,
		Profile:            snap.profile(),
		SpecHash:           snap.hash(),
		EffectiveHash:      effectiveHash(eff),
		InheritedFields:    inherited,
	}
}
