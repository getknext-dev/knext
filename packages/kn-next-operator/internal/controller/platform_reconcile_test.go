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
	"fmt"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	"sigs.k8s.io/yaml"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// End-to-end behaviour of the platform layer through the REAL Reconcile, against
// a fake client (the API-server-specific behaviour — CRD admission, status
// subresource, the manager wiring — is covered by the envtests beside this file).
// Where zero_diff_golden_test.go proves the layer is invisible when absent,
// these prove it does exactly what ADR-0064 says when present.

const platformTestImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

type platformHarness struct {
	t      *testing.T
	scheme *runtime.Scheme
	c      client.Client
	r      *NextAppReconciler
	rec    *record.FakeRecorder
	now    time.Time
}

func newPlatformHarness(t *testing.T, objs ...client.Object) *platformHarness {
	t.Helper()
	scheme := goldenTestScheme(t, true)
	h := &platformHarness{
		t:      t,
		scheme: scheme,
		rec:    record.NewFakeRecorder(1000),
		now:    time.Date(2026, time.January, 14, 10, 0, 0, 0, time.UTC),
	}
	h.c = fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(objs...).
		WithStatusSubresource(&appsv1alpha1.NextApp{}, &platformv1alpha1.KnextPlatform{}).
		Build()
	h.r = &NextAppReconciler{
		Client:             h.c,
		Scheme:             scheme,
		Recorder:           h.rec,
		Clock:              func() time.Time { return h.now },
		PlatformCRDPresent: true,
	}
	return h
}

func appNamed(name string, mut func(*appsv1alpha1.NextApp)) *appsv1alpha1.NextApp {
	a := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default", UID: types.UID("uid-" + name), Generation: 1},
		Spec:       appsv1alpha1.NextAppSpec{Image: platformTestImage},
	}
	if mut != nil {
		mut(a)
	}
	return a
}

func platformObj(generation int64, mut func(*platformv1alpha1.KnextPlatformSpec)) *platformv1alpha1.KnextPlatform {
	p := &platformv1alpha1.KnextPlatform{ObjectMeta: metav1.ObjectMeta{
		Name: platformv1alpha1.SingletonName, Generation: generation, UID: "platform-uid-sentinel",
	}}
	if mut != nil {
		mut(&p.Spec)
	}
	return p
}

func (h *platformHarness) reconcile(name string) ctrl.Result {
	h.t.Helper()
	res, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: name}})
	if err != nil {
		h.t.Fatalf("reconcile %s: %v", name, err)
	}
	return res
}

func (h *platformHarness) app(name string) *appsv1alpha1.NextApp {
	h.t.Helper()
	a := &appsv1alpha1.NextApp{}
	if err := h.c.Get(context.Background(), types.NamespacedName{Namespace: "default", Name: name}, a); err != nil {
		h.t.Fatalf("get app %s: %v", name, err)
	}
	return a
}

func (h *platformHarness) ksvc(name string) *servingv1.Service {
	h.t.Helper()
	k := &servingv1.Service{}
	if err := h.c.Get(context.Background(), types.NamespacedName{Namespace: "default", Name: name}, k); err != nil {
		h.t.Fatalf("get ksvc %s: %v", name, err)
	}
	return k
}

func (h *platformHarness) ksvcExists(name string) bool {
	k := &servingv1.Service{}
	return h.c.Get(context.Background(), types.NamespacedName{Namespace: "default", Name: name}, k) == nil
}

// setPlatform creates or updates the singleton, bumping generation the way the
// API server does on a spec change.
func (h *platformHarness) setPlatform(mut func(*platformv1alpha1.KnextPlatformSpec)) {
	h.t.Helper()
	ctx := context.Background()
	cur := &platformv1alpha1.KnextPlatform{}
	err := h.c.Get(ctx, types.NamespacedName{Name: platformv1alpha1.SingletonName}, cur)
	if err != nil {
		if err := h.c.Create(ctx, platformObj(1, mut)); err != nil {
			h.t.Fatalf("create platform: %v", err)
		}
		return
	}
	mut(&cur.Spec)
	cur.Generation++
	if err := h.c.Update(ctx, cur); err != nil {
		h.t.Fatalf("update platform: %v", err)
	}
}

func (h *platformHarness) deletePlatform() {
	h.t.Helper()
	if err := h.c.Delete(context.Background(), &platformv1alpha1.KnextPlatform{ObjectMeta: metav1.ObjectMeta{Name: platformv1alpha1.SingletonName}}); err != nil {
		h.t.Fatalf("delete platform: %v", err)
	}
}

func (h *platformHarness) condition(name, condType string) *metav1.Condition {
	return apimeta.FindStatusCondition(h.app(name).Status.Conditions, condType)
}

func (h *platformHarness) drainEvents() []string {
	var out []string
	for {
		select {
		case e := <-h.rec.Events:
			out = append(out, e)
		default:
			return out
		}
	}
}

// qty renders one resource quantity (ResourceList accessors need an addressable value).
func qty(rl corev1.ResourceList, name corev1.ResourceName) string {
	q := rl[name]
	return q.String()
}

func containerOf(k *servingv1.Service) corev1.Container {
	return k.Spec.Template.Spec.Containers[0]
}

// --- precedence, rendered --------------------------------------------------

func TestPlatform_DefaultsReachTheRenderedService(t *testing.T) {
	h := newPlatformHarness(t, appNamed("web", nil), platformObj(3, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Scaling = &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{
			ContainerConcurrency:     40,
			ScaleDownDelay:           "5m",
			TargetBurstCapacity:      ptr.To[int32](-1),
			PanicWindowPercentage:    ptr.To[int32](20),
			PanicThresholdPercentage: ptr.To[int32](300),
		}}
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{
			CPURequest: "500m", CPULimit: "2", MemoryRequest: "1Gi", MemoryLimit: "2Gi",
		}}
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}
	}))
	h.reconcile("web")

	k := h.ksvc("web")
	if cc := *k.Spec.Template.Spec.ContainerConcurrency; cc != 40 {
		t.Errorf("containerConcurrency = %d, want the platform's 40", cc)
	}
	if to := *k.Spec.Template.Spec.TimeoutSeconds; to != 600 {
		t.Errorf("timeoutSeconds = %d, want the platform's 600", to)
	}
	res := containerOf(k).Resources
	for name, want := range map[string]string{"req.cpu": "500m", "lim.cpu": "2", "req.mem": "1Gi", "lim.mem": "2Gi"} {
		var got string
		switch name {
		case "req.cpu":
			got = qty(res.Requests, corev1.ResourceCPU)
		case "lim.cpu":
			got = qty(res.Limits, corev1.ResourceCPU)
		case "req.mem":
			got = qty(res.Requests, corev1.ResourceMemory)
		case "lim.mem":
			got = qty(res.Limits, corev1.ResourceMemory)
		}
		if got != want {
			t.Errorf("%s = %s, want %s", name, got, want)
		}
	}
	ann := k.Spec.Template.Annotations
	for key, want := range map[string]string{
		"autoscaling.knative.dev/scale-down-delay":           "5m",
		"autoscaling.knative.dev/target-burst-capacity":      "-1",
		"autoscaling.knative.dev/panic-window-percentage":    "20",
		"autoscaling.knative.dev/panic-threshold-percentage": "300",
	} {
		if ann[key] != want {
			t.Errorf("annotation %s = %q, want %q", key, ann[key], want)
		}
	}
}

func TestPlatform_TheAppAlwaysWinsAndMixesPerField(t *testing.T) {
	h := newPlatformHarness(t,
		appNamed("web", func(a *appsv1alpha1.NextApp) {
			a.Spec.Resources = &appsv1alpha1.ResourcesSpec{CPULimit: "4"}
			a.Spec.Scaling = &appsv1alpha1.ScalingSpec{ContainerConcurrency: 100, TargetBurstCapacity: ptr.To[int32](0)}
			a.Spec.TimeoutSeconds = 90
		}),
		platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
			s.Scaling = &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{
				ContainerConcurrency: 40, TargetBurstCapacity: ptr.To[int32](500), ScaleDownDelay: "5m",
			}}
			s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "2", MemoryLimit: "2Gi"}}
			s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}
		}))
	h.reconcile("web")

	k := h.ksvc("web")
	if cc := *k.Spec.Template.Spec.ContainerConcurrency; cc != 100 {
		t.Errorf("containerConcurrency = %d, want the app's 100", cc)
	}
	if to := *k.Spec.Template.Spec.TimeoutSeconds; to != 90 {
		t.Errorf("timeoutSeconds = %d, want the app's 90", to)
	}
	if got := qty(containerOf(k).Resources.Limits, corev1.ResourceCPU); got != "4" {
		t.Errorf("cpuLimit = %s, want the app's 4", got)
	}
	if got := qty(containerOf(k).Resources.Limits, corev1.ResourceMemory); got != "2Gi" {
		t.Errorf("memoryLimit = %s, want the platform's 2Gi (the app left it unset)", got)
	}
	ann := k.Spec.Template.Annotations
	if ann["autoscaling.knative.dev/target-burst-capacity"] != "0" {
		t.Errorf("target-burst-capacity = %q, want the app's explicit 0", ann["autoscaling.knative.dev/target-burst-capacity"])
	}
	if ann["autoscaling.knative.dev/scale-down-delay"] != "5m" {
		t.Errorf("scale-down-delay = %q, want the platform's 5m", ann["autoscaling.knative.dev/scale-down-delay"])
	}
}

// A preview is ephemeral and drops scale-down-delay (#770). The platform's
// default must not smuggle one back in.
func TestPlatform_ScaleDownDelayStillDroppedForPreviews(t *testing.T) {
	h := newPlatformHarness(t,
		appNamed("pr", func(a *appsv1alpha1.NextApp) {
			a.Spec.Preview = &appsv1alpha1.PreviewSpec{Enabled: true, PRID: "9"}
		}),
		platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
			s.Scaling = &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{ScaleDownDelay: "30m"}}
		}))
	h.reconcile("pr")
	if v, ok := h.ksvc("pr").Spec.Template.Annotations["autoscaling.knative.dev/scale-down-delay"]; ok {
		t.Errorf("a preview carries scale-down-delay=%q from the platform; previews drop it", v)
	}
}

// --- observability of the merge ---------------------------------------------

func TestPlatform_StatusAndConditionRecordTheMerge(t *testing.T) {
	h := newPlatformHarness(t, appNamed("web", func(a *appsv1alpha1.NextApp) {
		a.Spec.Resources = &appsv1alpha1.ResourcesSpec{CPULimit: "4"}
	}), platformObj(7, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Profile = platformv1alpha1.ProfileDefault
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "2", MemoryLimit: "2Gi"}}
	}))
	h.reconcile("web")

	app := h.app("web")
	p := app.Status.Platform
	if p == nil {
		t.Fatal("status.platform is nil with a platform in force")
	}
	if p.ObservedGeneration != 7 || p.Profile != platformv1alpha1.ProfileDefault {
		t.Errorf("status.platform = %+v, want generation 7 profile default", p)
	}
	want := []string{"spec.resources.memoryLimit", "spec.timeoutSeconds"}
	if strings.Join(p.InheritedFields, ",") != strings.Join(want, ",") {
		t.Errorf("inheritedFields = %v, want %v (cpuLimit is the app's own)", p.InheritedFields, want)
	}
	if p.SpecHash == "" || p.EffectiveHash == "" {
		t.Errorf("hashes must be recorded: %+v", p)
	}

	cond := h.condition("web", ConditionPlatformDefaultsApplied)
	if cond == nil || cond.Status != metav1.ConditionTrue || cond.Reason != ReasonInherited {
		t.Fatalf("PlatformDefaultsApplied = %+v, want True/Inherited", cond)
	}
	if !strings.Contains(cond.Message, "spec.timeoutSeconds") || strings.Contains(cond.Message, "spec.resources.cpuLimit") {
		t.Errorf("message should list exactly what was inherited: %q", cond.Message)
	}
}

func TestPlatform_WithoutOneTheStatusStaysUntouchedAndSaysWhy(t *testing.T) {
	// No object: CRD present.
	h := newPlatformHarness(t, appNamed("web", nil))
	h.reconcile("web")
	if h.app("web").Status.Platform != nil {
		t.Error("status.platform must stay nil on a cluster with no platform (no new status for non-adopters)")
	}
	c := h.condition("web", ConditionPlatformDefaultsApplied)
	if c == nil || c.Status != metav1.ConditionTrue || c.Reason != ReasonNoPlatform {
		t.Errorf("condition = %+v, want True/NoPlatform", c)
	}

	// CRD not installed.
	h2 := newPlatformHarness(t, appNamed("web", nil))
	h2.r.PlatformCRDPresent = false
	h2.reconcile("web")
	c2 := h2.condition("web", ConditionPlatformDefaultsApplied)
	if c2 == nil || c2.Status != metav1.ConditionTrue || c2.Reason != ReasonNoPlatformCRD {
		t.Errorf("condition = %+v, want True/NoPlatformCRD", c2)
	}
	if h2.app("web").Status.Platform != nil {
		t.Error("status.platform must be nil when the CRD is absent")
	}
}

func TestPlatform_EmptyPlatformReportsNothingToInherit(t *testing.T) {
	h := newPlatformHarness(t, appNamed("web", nil), platformObj(2, nil))
	h.reconcile("web")
	c := h.condition("web", ConditionPlatformDefaultsApplied)
	if c == nil || c.Status != metav1.ConditionTrue || c.Reason != ReasonNothingToInherit {
		t.Fatalf("condition = %+v, want True/NothingToInherit", c)
	}
	if p := h.app("web").Status.Platform; p == nil || p.ObservedGeneration != 2 || len(p.InheritedFields) != 0 {
		t.Errorf("status.platform = %+v, want generation 2 and nothing inherited", p)
	}
}

// ADR-0064 D3: platform identity lives ONLY in status. A revision template that
// carried the generation, the profile or a hash would roll a new revision on
// every operator upgrade and every no-op platform edit.
func TestPlatform_IdentityNeverLeaksIntoTheRevisionTemplate(t *testing.T) {
	h := newPlatformHarness(t, appNamed("web", func(a *appsv1alpha1.NextApp) {
		a.Spec.Resources = &appsv1alpha1.ResourcesSpec{MemoryLimit: "3Gi"} // platform memory never applies
	}), platformObj(4242, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Profile = platformv1alpha1.ProfileFastColdStart
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 450}
	}))
	h.reconcile("web")

	k := h.ksvc("web")
	app := h.app("web")
	raw, err := yaml.Marshal(k.Spec.Template)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := string(raw)
	for _, sentinel := range []string{
		"4242", "platform-uid-sentinel", app.Status.Platform.SpecHash, app.Status.Platform.EffectiveHash,
		platformv1alpha1.ProfileFastColdStart, strings.ToLower(platformv1alpha1.ProfileFastColdStart), "knextplatform", "platform.kn-next.dev",
	} {
		if sentinel != "" && strings.Contains(tmpl, sentinel) {
			t.Errorf("revision template contains %q — platform identity must live only in NextApp status:\n%s", sentinel, tmpl)
		}
	}
	for k, v := range h.ksvc("web").Labels {
		if strings.Contains(strings.ToLower(k+v), "platform") {
			t.Errorf("ksvc label %s=%s leaks platform identity", k, v)
		}
	}
}

// A platform edit that changes no effective value for an app must not touch its
// Knative Service: no new revision, so no pod boot (D3, F2).
func TestPlatform_EditThatChangesNothingForTheAppRollsNoRevision(t *testing.T) {
	h := newPlatformHarness(t, appNamed("web", func(a *appsv1alpha1.NextApp) {
		a.Spec.Resources = &appsv1alpha1.ResourcesSpec{
			CPURequest: "300m", CPULimit: "1", MemoryRequest: "256Mi", MemoryLimit: "1Gi",
		}
		a.Spec.TimeoutSeconds = 60
		a.Spec.Scaling = &appsv1alpha1.ScalingSpec{MaxScale: 5, ContainerConcurrency: 30}
	}), platformObj(1, nil))
	h.reconcile("web")
	before := h.ksvc("web")

	// The platform now sets values this app overrides every one of.
	h.setPlatform(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "8", MemoryLimit: "16Gi"}}
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 900}
		s.Scaling = &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{ContainerConcurrency: 9}}
	})
	res := h.reconcile("web")
	after := h.ksvc("web")

	if before.ResourceVersion != after.ResourceVersion {
		t.Errorf("the Knative Service was written (rv %s -> %s) although no effective value changed", before.ResourceVersion, after.ResourceVersion)
	}
	if res.RequeueAfter != 0 && h.condition("web", ConditionPlatformDefaultsApplied).Reason == ReasonRolloutPending {
		t.Error("an edit with no effect on this app must not queue it behind the limiter")
	}
	if got := h.app("web").Status.Platform.ObservedGeneration; got != 2 {
		t.Errorf("status.platform.observedGeneration = %d, want 2: the app was evaluated against the new platform", got)
	}
}

// --- an unusable platform is ignored, never merged --------------------------

func TestPlatform_NotAcceptedIsIgnoredAndReported(t *testing.T) {
	h := newPlatformHarness(t, appNamed("web", nil), platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
		// Passes the CRD's quantity pattern, fails the bounded parser (#635).
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "1e2147483648"}}
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 777}
	}))
	h.reconcile("web")

	k := h.ksvc("web")
	if got := qty(containerOf(k).Resources.Limits, corev1.ResourceCPU); got != "1" { // built-in 1000m
		t.Errorf("cpuLimit = %s: a platform that was not accepted must contribute NOTHING", got)
	}
	if to := *k.Spec.Template.Spec.TimeoutSeconds; to != 300 {
		t.Errorf("timeoutSeconds = %d: even its valid fields must be ignored when the object as a whole is not accepted", to)
	}
	c := h.condition("web", ConditionPlatformDefaultsApplied)
	if c == nil || c.Status != metav1.ConditionFalse || c.Reason != ReasonPlatformNotAccepted {
		t.Fatalf("condition = %+v, want False/PlatformNotAccepted", c)
	}
	if h.app("web").Status.Platform != nil {
		t.Error("status.platform must not claim a platform that was not merged")
	}
	if !hasEvent(h.drainEvents(), corev1.EventTypeWarning, ReasonPlatformNotAccepted) {
		t.Error("a platform that is not accepted must raise a Warning event")
	}
}

func hasEvent(events []string, typ, reason string) bool {
	for _, e := range events {
		if strings.HasPrefix(e, typ+" "+reason+" ") {
			return true
		}
	}
	return false
}

// --- F3: hold-last-good -------------------------------------------------------

func TestPlatform_LoweredBudgetHoldsTheLastGoodServiceAndNamesTheField(t *testing.T) {
	h := newPlatformHarness(t, appNamed("db", func(a *appsv1alpha1.NextApp) {
		a.Spec.Scaling = &appsv1alpha1.ScalingSpec{MaxScale: 8, PoolMax: 10} // 80: exactly the built-in budget
	}))
	h.reconcile("db")
	before := h.ksvc("db")

	// The admin lowers the budget below what the app declared.
	h.setPlatform(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 40}
	})
	h.drainEvents()
	h.reconcile("db")

	after := h.ksvc("db")
	if before.ResourceVersion != after.ResourceVersion {
		t.Error("the last-good Knative Service must be left untouched")
	}
	c := h.condition("db", ConditionPlatformDefaultsApplied)
	if c == nil || c.Status != metav1.ConditionFalse || c.Reason != ReasonEffectiveSpecInvalid {
		t.Fatalf("condition = %+v, want False/EffectiveSpecInvalid", c)
	}
	if !strings.Contains(c.Message, "spec.scaling") || !strings.Contains(c.Message, "40") {
		t.Errorf("message must name the field and the platform's budget: %q", c.Message)
	}
	if rdy := h.condition("db", ConditionReady); rdy == nil {
		t.Error("a held app must still get its Ready verdict from the live Service")
	}
	// It is NOT the ordinary InvalidSpec failure: that would mark the app Degraded
	// for something the app's author did not do.
	if d := h.condition("db", ConditionDegraded); d != nil && d.Reason == "InvalidSpec" {
		t.Error("a platform-caused failure must not be reported as the app's InvalidSpec")
	}
	if !hasEvent(h.drainEvents(), corev1.EventTypeWarning, ReasonEffectiveSpecInvalid) {
		t.Error("expected a Warning event on entering EffectiveSpecInvalid")
	}
	// A second pass in the same state is not news: no repeat event.
	h.reconcile("db")
	if hasEvent(h.drainEvents(), corev1.EventTypeWarning, ReasonEffectiveSpecInvalid) {
		t.Error("the Warning event must fire on the transition only, not on every pass")
	}

	// The admin relaxes the budget: the hold lifts on the next pass.
	h.setPlatform(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 100}
	})
	h.reconcile("db")
	if c := h.condition("db", ConditionPlatformDefaultsApplied); c == nil || c.Status != metav1.ConditionTrue {
		t.Errorf("condition after relaxing = %+v, want True", c)
	}
}

func TestPlatform_ABrandNewAppUnderAnInvalidPlatformIsNotCreated(t *testing.T) {
	h := newPlatformHarness(t,
		appNamed("fresh", func(a *appsv1alpha1.NextApp) {
			a.Spec.Scaling = &appsv1alpha1.ScalingSpec{MaxScale: 8, PoolMax: 10}
		}),
		platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
			s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 40}
		}))
	h.reconcile("fresh")
	if h.ksvcExists("fresh") {
		t.Error("there is no last-good Service to hold, and an invalid effective spec must not be rendered")
	}
	if c := h.condition("fresh", ConditionPlatformDefaultsApplied); c == nil || c.Reason != ReasonEffectiveSpecInvalid {
		t.Errorf("condition = %+v, want EffectiveSpecInvalid", c)
	}
}

// An app that is invalid on its own is NOT the platform's to hold: it fails the
// ordinary way, exactly as before the layer existed.
func TestPlatform_AnAppInvalidOnItsOwnStillFailsAsInvalidSpec(t *testing.T) {
	h := newPlatformHarness(t,
		appNamed("bad", func(a *appsv1alpha1.NextApp) {
			a.Spec.Scaling = &appsv1alpha1.ScalingSpec{MaxScale: 9, PoolMax: 9} // 81 > 80 AND > 40
		}),
		platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
			s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 40}
		}))
	_, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "bad"}})
	if err == nil {
		t.Fatal("an app over even the built-in budget must be rejected as before")
	}
	if c := h.condition("bad", ConditionReady); c == nil || c.Reason != "InvalidSpec" {
		t.Errorf("Ready = %+v, want reason InvalidSpec", c)
	}
}

func TestPlatform_ABudgetAboveTheBuiltinLetsALargerWallThrough(t *testing.T) {
	spec := func(a *appsv1alpha1.NextApp) { a.Spec.Scaling = &appsv1alpha1.ScalingSpec{MaxScale: 16, PoolMax: 10} } // 160
	// Without a platform: rejected, as always.
	h0 := newPlatformHarness(t, appNamed("big", spec))
	if _, err := h0.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "big"}}); err == nil {
		t.Fatal("160 connections must exceed the built-in budget of 80")
	}
	// With the platform's budget: accepted and rendered.
	h := newPlatformHarness(t, appNamed("big", spec), platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 160}
	}))
	h.reconcile("big")
	if !h.ksvcExists("big") {
		t.Error("the platform's larger budget should have admitted the app")
	}
}

func TestPlatform_ARequestAboveTheMergedLimitIsHeld(t *testing.T) {
	// Platform request 2 CPU against the BUILT-IN 1000m limit: a pod the API
	// server would refuse. Neither layer is wrong alone; the merge is.
	h := newPlatformHarness(t, appNamed("web", nil))
	h.reconcile("web")
	before := h.ksvc("web")

	h.setPlatform(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPURequest: "2"}}
	})
	h.reconcile("web")

	if before.ResourceVersion != h.ksvc("web").ResourceVersion {
		t.Error("the Service must be held, not re-rendered with a request above its limit")
	}
	c := h.condition("web", ConditionPlatformDefaultsApplied)
	if c == nil || c.Reason != ReasonEffectiveSpecInvalid || !strings.Contains(c.Message, "spec.resources.cpuRequest") {
		t.Errorf("condition = %+v, want EffectiveSpecInvalid naming spec.resources.cpuRequest", c)
	}
}

// --- F2: the rollout limiter ------------------------------------------------

func TestPlatform_AnEditRollsAppsAtTheConfiguredRateNotAllAtOnce(t *testing.T) {
	const apps = 5
	var objs []client.Object
	for i := 0; i < apps; i++ {
		objs = append(objs, appNamed(fmt.Sprintf("app-%d", i), nil))
	}
	h := newPlatformHarness(t, objs...)
	for i := 0; i < apps; i++ {
		h.reconcile(fmt.Sprintf("app-%d", i))
	}
	versions := map[string]string{}
	for i := 0; i < apps; i++ {
		versions[fmt.Sprintf("app-%d", i)] = h.ksvc(fmt.Sprintf("app-%d", i)).ResourceVersion
	}

	// One platform edit that changes every app: 2 per minute => 30s spacing.
	h.setPlatform(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Rollout = &platformv1alpha1.PlatformRollout{MaxAppsPerMinute: 2}
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "2"}}
	})

	rolled := func() []string {
		var out []string
		for i := 0; i < apps; i++ {
			n := fmt.Sprintf("app-%d", i)
			if h.ksvc(n).ResourceVersion != versions[n] {
				out = append(out, n)
			}
		}
		return out
	}

	// Everyone is reconciled at once, as the platform watch would enqueue them.
	requeues := map[string]time.Duration{}
	for i := 0; i < apps; i++ {
		n := fmt.Sprintf("app-%d", i)
		requeues[n] = h.reconcile(n).RequeueAfter
	}
	if got := rolled(); len(got) != 1 {
		t.Fatalf("after the edit %d apps rolled immediately (%v); the first slot is the only one that is free", len(got), got)
	}
	pending := 0
	for n, rq := range requeues {
		c := h.condition(n, ConditionPlatformDefaultsApplied)
		if c.Reason == ReasonRolloutPending {
			pending++
			if c.Status != metav1.ConditionUnknown {
				t.Errorf("%s pending status = %s, want Unknown", n, c.Status)
			}
			if rq < 30*time.Second {
				t.Errorf("%s requeue = %v, want at least its slot (>= 30s)", n, rq)
			}
		}
	}
	if pending != apps-1 {
		t.Fatalf("%d apps pending, want %d", pending, apps-1)
	}

	// Walk the clock: at no 60s window may more than 2 apps have rolled.
	var rollTimes []time.Time
	rollTimes = append(rollTimes, h.now) // the first one rolled at t0
	seen := 1
	for step := 0; step < 400 && seen < apps; step++ {
		h.now = h.now.Add(5 * time.Second)
		for i := 0; i < apps; i++ {
			h.reconcile(fmt.Sprintf("app-%d", i))
		}
		if got := len(rolled()); got > seen {
			for j := seen; j < got; j++ {
				rollTimes = append(rollTimes, h.now)
			}
			seen = got
		}
	}
	if seen != apps {
		t.Fatalf("only %d of %d apps ever rolled: the rollout must complete", seen, apps)
	}
	for i := range rollTimes {
		inWindow := 0
		for _, x := range rollTimes {
			if !x.Before(rollTimes[i]) && x.Before(rollTimes[i].Add(time.Minute)) {
				inWindow++
			}
		}
		if inWindow > 2 {
			t.Errorf("%d apps rolled within one minute of %v; the cap is 2 (%v)", inWindow, rollTimes[i], rollTimes)
		}
	}
	for i := 0; i < apps; i++ {
		n := fmt.Sprintf("app-%d", i)
		if c := h.condition(n, ConditionPlatformDefaultsApplied); c.Reason != ReasonInherited {
			t.Errorf("%s ended at %s, want Inherited", n, c.Reason)
		}
		if got := qty(containerOf(h.ksvc(n)).Resources.Limits, corev1.ResourceCPU); got != "2" {
			t.Errorf("%s cpuLimit = %s, want 2 after the rollout", n, got)
		}
	}
}

// The user's own deploy must not queue behind a platform backlog: it rolls a new
// revision anyway, and the platform values ride along in it.
func TestPlatform_AnAppsOwnChangeBypassesTheRolloutQueue(t *testing.T) {
	h := newPlatformHarness(t, appNamed("a", nil), appNamed("b", nil))
	h.reconcile("a")
	h.reconcile("b")
	h.setPlatform(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Rollout = &platformv1alpha1.PlatformRollout{MaxAppsPerMinute: 1}
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "2"}}
	})
	h.reconcile("a") // takes the only free slot
	h.reconcile("b") // queued
	if c := h.condition("b", ConditionPlatformDefaultsApplied); c.Reason != ReasonRolloutPending {
		t.Fatalf("setup: b should be queued, got %s", c.Reason)
	}

	// b's author deploys a new image: the generation moves.
	b := h.app("b")
	b.Spec.Image = strings.Replace(platformTestImage, "abc123", "fff999", 1)
	b.Generation++
	if err := h.c.Update(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	h.reconcile("b")

	if c := h.condition("b", ConditionPlatformDefaultsApplied); c.Reason != ReasonInherited {
		t.Errorf("b's own change should apply immediately with the platform values, got %s", c.Reason)
	}
	k := h.ksvc("b")
	if !strings.Contains(containerOf(k).Image, "fff999") || qty(containerOf(k).Resources.Limits, corev1.ResourceCPU) != "2" {
		t.Errorf("the new image and the platform cpuLimit should both be in b's Service: %+v", containerOf(k))
	}
}

// --- F8: the platform is deleted ---------------------------------------------

func TestPlatform_DeletingItRevertsAppsToBuiltinsAtTheBoundedRate(t *testing.T) {
	h := newPlatformHarness(t, appNamed("a", nil), appNamed("b", nil), platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}
		s.Rollout = &platformv1alpha1.PlatformRollout{MaxAppsPerMinute: 1}
	}))
	h.reconcile("a")
	h.reconcile("b")
	if *h.ksvc("a").Spec.Template.Spec.TimeoutSeconds != 600 {
		t.Fatal("setup: platform timeout not applied")
	}

	h.deletePlatform()
	h.reconcile("a")
	h.reconcile("b")

	rolledBack, queued := 0, 0
	for _, n := range []string{"a", "b"} {
		switch h.condition(n, ConditionPlatformDefaultsApplied).Reason {
		case ReasonNoPlatform:
			rolledBack++
			if h.app(n).Status.Platform != nil {
				t.Errorf("%s: status.platform must be cleared once the platform is gone", n)
			}
			if *h.ksvc(n).Spec.Template.Spec.TimeoutSeconds != 300 {
				t.Errorf("%s did not revert to the built-in timeout", n)
			}
		case ReasonRolloutPending:
			queued++
		}
	}
	// The pacing rate lived in the deleted object; the built-in rate (10/min)
	// governs the revert, so both may go — the point is nothing is lost.
	if rolledBack+queued != 2 {
		t.Errorf("both apps must either revert or be queued to: reverted %d queued %d", rolledBack, queued)
	}
}

// --- idempotence (#98) ----------------------------------------------------------

func TestPlatform_ConvergedPassWritesNothing(t *testing.T) {
	h := newPlatformHarness(t, appNamed("web", nil), platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}
	}))
	h.reconcile("web")
	h.reconcile("web")
	rv := h.app("web").ResourceVersion
	h.reconcile("web")
	if got := h.app("web").ResourceVersion; got != rv {
		t.Errorf("a converged pass rewrote the NextApp status (rv %s -> %s): the platform condition must be stable or the idle hot-loop returns", rv, got)
	}
}
