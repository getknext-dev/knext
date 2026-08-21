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
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"knative.dev/serving/pkg/apis/serving"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Cold-start probe shape. Measured on OKE (probe-shape A/B, n=6 per arm, same
// image/env/data plane): the operator's stamped
// ReadinessProbe{InitialDelaySeconds: 2, PeriodSeconds: 3} cost ~1.2s of
// median cold start (5723ms probed vs 4562ms unprobed). The signature was
// grid-quantization — the probed arm's container->Ready landed ONLY on
// probe-grid values (2000/3000/5000ms), i.e. readiness was gated by the probe
// clock, not by the app.
//
// Cause: an explicit periodSeconds opts the revision OUT of Knative's
// aggressive sub-second readiness probing (queue-proxy retries), and
// initialDelaySeconds blinds the first 2s outright. Knative signals aggressive
// mode with periodSeconds == 0 / unset.
//
// These tests assert BOTH halves: the httpGet health-path semantics are
// preserved (#338 shallow path), AND the timing fields are Knative-aggressive.

// buildProbeTestKsvc builds the desired ksvc for a minimal NextApp.
func buildProbeTestKsvc(t *testing.T) (*appsv1alpha1.NextApp, *servingv1.Service) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := appsv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme: %v", err)
	}
	if err := servingv1.AddToScheme(scheme); err != nil {
		t.Fatalf("serving AddToScheme: %v", err)
	}
	r := &NextAppReconciler{Scheme: scheme}
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec: appsv1alpha1.NextAppSpec{
			// full-length digest: Knative's own validation parses the ref.
			Image: "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
		},
	}
	ksvc := &servingv1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
	}
	if err := r.buildDesiredKsvc(app, ksvc); err != nil {
		t.Fatalf("buildDesiredKsvc: %v", err)
	}
	return app, ksvc
}

func probeTestContainer(t *testing.T, ksvc *servingv1.Service) corev1.Container {
	t.Helper()
	if len(ksvc.Spec.Template.Spec.Containers) != 1 {
		t.Fatalf("expected exactly 1 container, got %d", len(ksvc.Spec.Template.Spec.Containers))
	}
	return ksvc.Spec.Template.Spec.Containers[0]
}

// Half 1 (semantics): the readiness probe must stay an HTTP GET on the shallow
// health path. Switching to tcpSocket would drop the health-path semantics.
func TestReadinessProbeKeepsHTTPGetHealthPath(t *testing.T) {
	app, ksvc := buildProbeTestKsvc(t)
	c := probeTestContainer(t, ksvc)

	if c.ReadinessProbe == nil {
		t.Fatalf("no readiness probe stamped")
	}
	if c.ReadinessProbe.HTTPGet == nil {
		t.Fatalf("readiness probe must use httpGet (health-path semantics), got %+v", c.ReadinessProbe.ProbeHandler)
	}
	want := readinessProbePath(app)
	if got := c.ReadinessProbe.HTTPGet.Path; got != want {
		t.Fatalf("readiness httpGet.path = %q, want the shallow health path %q", got, want)
	}
	if got := c.ReadinessProbe.HTTPGet.Port.IntValue(); got != 3000 {
		t.Fatalf("readiness httpGet.port = %d, want the container port 3000", got)
	}
}

// Half 2 (timing): the readiness probe must be Knative-aggressive — no initial
// delay, and periodSeconds unset/0. Any non-zero period reintroduces the
// measured ~1.2s grid-quantized cold-start tax.
func TestReadinessProbeIsKnativeAggressive(t *testing.T) {
	_, ksvc := buildProbeTestKsvc(t)
	p := probeTestContainer(t, ksvc).ReadinessProbe
	if p == nil {
		t.Fatalf("no readiness probe stamped")
	}
	if p.InitialDelaySeconds != 0 {
		t.Fatalf("readiness initialDelaySeconds = %d, want 0 (a delay blinds the first %ds of every cold start)", p.InitialDelaySeconds, p.InitialDelaySeconds)
	}
	if p.PeriodSeconds != 0 {
		t.Fatalf("readiness periodSeconds = %d, want 0/unset — a non-zero period disables Knative's aggressive sub-second probing", p.PeriodSeconds)
	}
	// Knative REJECTS these when periodSeconds == 0 (serving
	// k8s_validation.go validateReadinessProbe: "failureThreshold is
	// disallowed when periodSeconds is zero" / same for timeoutSeconds).
	if p.TimeoutSeconds != 0 {
		t.Fatalf("readiness timeoutSeconds = %d, must be 0 when periodSeconds is 0 (Knative rejects otherwise)", p.TimeoutSeconds)
	}
	if p.FailureThreshold != 0 {
		t.Fatalf("readiness failureThreshold = %d, must be 0 when periodSeconds is 0 (Knative rejects otherwise)", p.FailureThreshold)
	}
}

// The liveness probe is deliberately NOT aggressive: Knative has no aggressive
// mode for liveness, and sub-second liveness probing would restart-thrash a
// slow-starting container. It must keep an explicit, conservative period.
func TestLivenessProbeKeepsConservativePeriod(t *testing.T) {
	app, ksvc := buildProbeTestKsvc(t)
	p := probeTestContainer(t, ksvc).LivenessProbe
	if p == nil {
		t.Fatalf("no liveness probe stamped")
	}
	if p.HTTPGet == nil || p.HTTPGet.Path != readinessProbePath(app) {
		t.Fatalf("liveness probe must httpGet the shallow health path %q, got %+v", readinessProbePath(app), p.ProbeHandler)
	}
	if p.PeriodSeconds <= 0 {
		t.Fatalf("liveness periodSeconds = %d, want a positive explicit period (liveness has no aggressive mode)", p.PeriodSeconds)
	}
	if p.InitialDelaySeconds <= 0 {
		t.Fatalf("liveness initialDelaySeconds = %d, want a positive delay so a slow boot is not killed", p.InitialDelaySeconds)
	}
}

// The stamped probes must survive Knative's OWN defaulting + validation — this
// is the evidence that periodSeconds==0 is accepted (aggressive mode) rather
// than rejected or clamped by the serving webhook.
func TestStampedProbesPassKnativeValidation(t *testing.T) {
	_, ksvc := buildProbeTestKsvc(t)
	ctx := context.Background()

	ksvc.SetDefaults(ctx)

	// Defaulting must NOT have rewritten readiness away from aggressive mode.
	c := probeTestContainer(t, ksvc)
	if c.ReadinessProbe.PeriodSeconds != 0 {
		t.Fatalf("after Knative defaulting readiness periodSeconds = %d, want it left at 0 (aggressive)", c.ReadinessProbe.PeriodSeconds)
	}
	if c.ReadinessProbe.SuccessThreshold != 1 {
		t.Fatalf("after Knative defaulting readiness successThreshold = %d, want the Knative default 1", c.ReadinessProbe.SuccessThreshold)
	}

	if err := serving.ValidateUserContainer(ctx, c, nil, c.Ports[0]); err != nil {
		t.Fatalf("Knative rejected the stamped container: %v", err)
	}
}
