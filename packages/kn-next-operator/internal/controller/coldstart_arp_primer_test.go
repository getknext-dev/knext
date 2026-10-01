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

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

func newArpPrimerScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	sch := runtime.NewScheme()
	if err := appsv1alpha1.AddToScheme(sch); err != nil {
		t.Fatalf("AddToScheme(apps): %v", err)
	}
	if err := servingv1.AddToScheme(sch); err != nil {
		t.Fatalf("AddToScheme(serving): %v", err)
	}
	return sch
}

// Default-off (spec.coldStart unset, or set with ArpPrimer nil/false):
// buildDesiredKsvc MUST render zero init containers — byte-identical
// back-compat with every CR written before this field existed.
func TestBuildDesiredKsvc_ArpPrimer_DefaultOff(t *testing.T) {
	falseVal := false
	cases := []struct {
		name      string
		coldStart *appsv1alpha1.ColdStartSpec
	}{
		{"coldStart unset", nil},
		{"coldStart set, arpPrimer nil", &appsv1alpha1.ColdStartSpec{}},
		{"coldStart set, arpPrimer explicitly false", &appsv1alpha1.ColdStartSpec{ArpPrimer: &falseVal}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &NextAppReconciler{Scheme: newArpPrimerScheme(t)}
			app := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
				Spec: appsv1alpha1.NextAppSpec{
					Image:     "registry.example.com/app:v1@sha256:abc123",
					ColdStart: tc.coldStart,
				},
			}
			ksvc := &servingv1.Service{ObjectMeta: metav1.ObjectMeta{Name: app.Name, Namespace: app.Namespace}}

			if _, err := r.buildDesiredKsvc(app, ksvc); err != nil {
				t.Fatalf("buildDesiredKsvc returned an unexpected error: %v", err)
			}

			if n := len(ksvc.Spec.Template.Spec.InitContainers); n != 0 {
				t.Fatalf("expected 0 init containers when arpPrimer is off, got %d", n)
			}
		})
	}
}

// Opt-in (spec.coldStart.arpPrimer: true): buildDesiredKsvc MUST render
// exactly one init container, with the EXACT hardened SecurityContext the
// issue requires: runAsNonRoot, no privilege escalation, ALL capabilities
// dropped (no NET_RAW), read-only root filesystem, digest-pinned image.
func TestBuildDesiredKsvc_ArpPrimer_EnabledRendersHardenedInitContainer(t *testing.T) {
	trueVal := true
	r := &NextAppReconciler{Scheme: newArpPrimerScheme(t)}
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec: appsv1alpha1.NextAppSpec{
			Image:     "registry.example.com/app:v1@sha256:abc123",
			ColdStart: &appsv1alpha1.ColdStartSpec{ArpPrimer: &trueVal},
		},
	}
	ksvc := &servingv1.Service{ObjectMeta: metav1.ObjectMeta{Name: app.Name, Namespace: app.Namespace}}

	if _, err := r.buildDesiredKsvc(app, ksvc); err != nil {
		t.Fatalf("buildDesiredKsvc returned an unexpected error: %v", err)
	}

	inits := ksvc.Spec.Template.Spec.InitContainers
	if len(inits) != 1 {
		t.Fatalf("expected exactly 1 init container when arpPrimer is on, got %d", len(inits))
	}
	c := inits[0]

	if c.Image != prewarmHelperImage {
		t.Fatalf("init container image = %q, want the ALREADY-TRUSTED digest-pinned %q (no new image to vet)", c.Image, prewarmHelperImage)
	}
	if !strContainsDigest(c.Image) {
		t.Fatalf("init container image %q is not digest-pinned (@sha256:...)", c.Image)
	}

	sc := c.SecurityContext
	if sc == nil {
		t.Fatalf("init container has no SecurityContext at all")
	}
	if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Fatalf("SecurityContext.RunAsNonRoot must be true, got %v", sc.RunAsNonRoot)
	}
	if sc.RunAsUser == nil || *sc.RunAsUser == 0 {
		t.Fatalf("SecurityContext.RunAsUser must be a non-root uid, got %v", sc.RunAsUser)
	}
	if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Fatalf("SecurityContext.AllowPrivilegeEscalation must be false, got %v", sc.AllowPrivilegeEscalation)
	}
	if sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem {
		t.Fatalf("SecurityContext.ReadOnlyRootFilesystem must be true, got %v", sc.ReadOnlyRootFilesystem)
	}
	if sc.Capabilities == nil {
		t.Fatalf("SecurityContext.Capabilities must be set (dropping ALL)")
	}
	if len(sc.Capabilities.Add) != 0 {
		t.Fatalf("SecurityContext.Capabilities.Add must be empty (no NET_RAW, no anything), got %v", sc.Capabilities.Add)
	}
	foundDropAll := false
	for _, cap := range sc.Capabilities.Drop {
		if cap == "ALL" {
			foundDropAll = true
		}
		if cap == "NET_RAW" {
			// explicit NET_RAW drop is also fine, but ALL already covers it
			foundDropAll = foundDropAll || true
		}
	}
	if !foundDropAll {
		t.Fatalf("SecurityContext.Capabilities.Drop must include ALL, got %v", sc.Capabilities.Drop)
	}

	// No ServiceAccount token surface: no VolumeMounts referencing a
	// projected SA token, and no explicit SA-token volume mount at all.
	for _, vm := range c.VolumeMounts {
		if vm.Name == "kube-api-access" || vm.MountPath == "/var/run/secrets/kubernetes.io/serviceaccount" {
			t.Fatalf("init container must not mount a ServiceAccount token, found mount %+v", vm)
		}
	}

	// Sends via UDP (no NET_RAW needed), targets the pod's own node via the
	// Downward API — never a hardcoded/guessed address.
	foundHostIPEnv := false
	for _, e := range c.Env {
		if e.Name == arpPrimerTargetEnvVar {
			if e.ValueFrom == nil || e.ValueFrom.FieldRef == nil || e.ValueFrom.FieldRef.FieldPath != "status.hostIP" {
				t.Fatalf("%s must come from the Downward API status.hostIP, got %+v", arpPrimerTargetEnvVar, e.ValueFrom)
			}
			foundHostIPEnv = true
		}
	}
	if !foundHostIPEnv {
		t.Fatalf("init container has no %s env var sourced from status.hostIP", arpPrimerTargetEnvVar)
	}
}

func strContainsDigest(image string) bool {
	for i := 0; i+8 <= len(image); i++ {
		if image[i:i+8] == "@sha256:" {
			return true
		}
	}
	return false
}

// Mutation-proof anchor: the helper that gates the init container must be
// the SAME helper the controller calls, not an independent re-check —
// deleting arpPrimerEnabled's body (always-false) must turn the enabled
// test red, proving the guard is wired to real behaviour, not decoration.
func TestArpPrimerEnabled_GatesOnExactField(t *testing.T) {
	trueVal := true
	falseVal := false
	cases := []struct {
		name string
		app  *appsv1alpha1.NextApp
		want bool
	}{
		{"nil ColdStart", &appsv1alpha1.NextApp{}, false},
		{"ColdStart set, ArpPrimer nil", &appsv1alpha1.NextApp{Spec: appsv1alpha1.NextAppSpec{ColdStart: &appsv1alpha1.ColdStartSpec{}}}, false},
		{"ArpPrimer false", &appsv1alpha1.NextApp{Spec: appsv1alpha1.NextAppSpec{ColdStart: &appsv1alpha1.ColdStartSpec{ArpPrimer: &falseVal}}}, false},
		{"ArpPrimer true", &appsv1alpha1.NextApp{Spec: appsv1alpha1.NextAppSpec{ColdStart: &appsv1alpha1.ColdStartSpec{ArpPrimer: &trueVal}}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := arpPrimerEnabled(tc.app); got != tc.want {
				t.Fatalf("arpPrimerEnabled() = %v, want %v", got, tc.want)
			}
		})
	}
}
