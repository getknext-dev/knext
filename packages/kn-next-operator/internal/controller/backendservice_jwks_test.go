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
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"knative.dev/pkg/apis"
	duckv1 "knative.dev/pkg/apis/duck/v1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// A function mounts its zone's JWKS only when the zone's NextApp CONTROLS the
// ConfigMap (a squatter, or an object left by an earlier NextApp of the same
// name, must not become the key set the function verifies against). The pure
// halves are here: the ownership classification, the render, and the verdict.
// backendservice_jwks_envtest_test.go proves the same end to end, and
// scripts/mutation-prove-2052-backendservice.mjs mutates each of them.

const jwksZoneUID = types.UID("uid-orders-current")

func jwksZone() *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: sovNS, UID: jwksZoneUID}}
}

func jwksConfigMap(refs ...metav1.OwnerReference) *metav1.PartialObjectMetadata {
	return &metav1.PartialObjectMetadata{ObjectMeta: metav1.ObjectMeta{
		Name: ZoneJWKSConfigMapName("orders"), Namespace: sovNS, OwnerReferences: refs,
	}}
}

func nextAppRef(name string, uid types.UID, controller bool) metav1.OwnerReference {
	return metav1.OwnerReference{
		APIVersion: appsv1alpha1.GroupVersion.String(), Kind: "NextApp", Name: name, UID: uid,
		Controller: ptr.To(controller),
	}
}

func TestClassifyZoneJWKS(t *testing.T) {
	cases := []struct {
		name       string
		cm         *metav1.PartialObjectMetadata
		want       zoneJWKSState
		wantDetail string
	}{
		{"does not exist yet", nil, zoneJWKSAbsent, ""},
		{"controlled by the zone's NextApp (name and UID)", jwksConfigMap(nextAppRef("orders", jwksZoneUID, true)), zoneJWKSControlled, ""},
		{"squatted: no ownerReference at all", jwksConfigMap(), zoneJWKSUntrusted, "no controller ownerReference"},
		{"controlled by a different kind of object", jwksConfigMap(metav1.OwnerReference{
			APIVersion: "v1", Kind: "ConfigMap", Name: "orders", UID: jwksZoneUID, Controller: ptr.To(true),
		}), zoneJWKSUntrusted, `ConfigMap "orders"`},
		{"controlled by another kind in the zone's own API group that carries the zone's name and UID", jwksConfigMap(metav1.OwnerReference{
			APIVersion: appsv1alpha1.GroupVersion.String(), Kind: "BackendService", Name: "orders", UID: jwksZoneUID, Controller: ptr.To(true),
		}), zoneJWKSUntrusted, `BackendService "orders"`},
		{"controlled by another zone's NextApp", jwksConfigMap(nextAppRef("billing", "uid-billing", true)), zoneJWKSUntrusted, `NextApp "billing"`},
		{"controlled by a NextApp of the same name but another UID (an earlier incarnation)",
			jwksConfigMap(nextAppRef("orders", "uid-orders-previous", true)), zoneJWKSUntrusted, "different UID"},
		{"the zone is an owner but not the controller", jwksConfigMap(nextAppRef("orders", jwksZoneUID, false)), zoneJWKSUntrusted, "no controller ownerReference"},
		{"a controller from a foreign API group that looks like the zone", jwksConfigMap(metav1.OwnerReference{
			APIVersion: "example.com/v1", Kind: "NextApp", Name: "orders", UID: jwksZoneUID, Controller: ptr.To(true),
		}), zoneJWKSUntrusted, `NextApp "orders"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, detail := classifyZoneJWKS(tc.cm, jwksZone())
			if got != tc.want {
				t.Fatalf("classifyZoneJWKS = %v, want %v (detail %q)", got, tc.want, detail)
			}
			if !strings.Contains(detail, tc.wantDetail) {
				t.Errorf("detail %q does not contain %q", detail, tc.wantDetail)
			}
			if tc.want != zoneJWKSUntrusted && detail != "" {
				t.Errorf("detail %q for a state that is not untrusted", detail)
			}
		})
	}
}

// --- the render -------------------------------------------------------------

func renderWithJWKS(t *testing.T, state zoneJWKSState) *servingv1.Service {
	t.Helper()
	bs := sovFunction(appsv1alpha1.BackendServiceSpec{Image: "img"})
	ksvc := &servingv1.Service{}
	if err := buildFunctionKsvc(bs, 0, state, ksvc); err != nil {
		t.Fatal(err)
	}
	return ksvc
}

func jwksVolumes(ksvc *servingv1.Service) (vols []corev1.Volume, mounts []corev1.VolumeMount) {
	for _, v := range ksvc.Spec.Template.Spec.Volumes {
		if v.Name == FunctionJWKSVolumeName || (v.ConfigMap != nil && v.ConfigMap.Name == ZoneJWKSConfigMapName("orders")) {
			vols = append(vols, v)
		}
	}
	for _, m := range ksvc.Spec.Template.Spec.Containers[0].VolumeMounts {
		if m.Name == FunctionJWKSVolumeName || m.MountPath == ZoneJWKSMountDir {
			mounts = append(mounts, m)
		}
	}
	return vols, mounts
}

func TestRenderMountsTheZoneJWKSUnlessUntrusted(t *testing.T) {
	for _, state := range []zoneJWKSState{zoneJWKSAbsent, zoneJWKSControlled} {
		vols, mounts := jwksVolumes(renderWithJWKS(t, state))
		if len(vols) != 1 || vols[0].ConfigMap == nil || vols[0].ConfigMap.Name != ZoneJWKSConfigMapName("orders") {
			t.Fatalf("state %v: want the zone's JWKS ConfigMap volume, got %+v", state, vols)
		}
		// Optional even when the ConfigMap exists: if it is deleted later the
		// pod must still start (and refuse every call), not hang unscheduled.
		if !ptr.Deref(vols[0].ConfigMap.Optional, false) {
			t.Errorf("state %v: the JWKS volume must stay optional", state)
		}
		if len(mounts) != 1 || mounts[0].MountPath != ZoneJWKSMountDir || !mounts[0].ReadOnly || mounts[0].SubPath != "" {
			t.Errorf("state %v: want a read-only directory mount at %s, got %+v", state, ZoneJWKSMountDir, mounts)
		}
	}
}

func TestRenderMountsNoJWKSWhenUntrusted(t *testing.T) {
	ksvc := renderWithJWKS(t, zoneJWKSUntrusted)
	vols, mounts := jwksVolumes(ksvc)
	if len(vols) != 0 || len(mounts) != 0 {
		t.Fatalf("an untrusted JWKS ConfigMap must not be mounted at all; got volumes %+v mounts %+v", vols, mounts)
	}
	// Fail closed means the function still renders (health works) and is still
	// cluster-local; only the key set is withheld.
	if ksvc.Labels["networking.knative.dev/visibility"] != VisibilityClusterLocalLabelValue {
		t.Errorf("an untrusted-JWKS function must stay cluster-local, labels %v", ksvc.Labels)
	}
	if len(ksvc.Spec.Template.Spec.Containers) != 1 {
		t.Fatalf("want the function container, got %d containers", len(ksvc.Spec.Template.Spec.Containers))
	}
	env := ksvc.Spec.Template.Spec.Containers[0].Env
	if envValue(env, "KNEXT_TOKEN_ISSUER") == "" || envValue(env, "KNEXT_TOKEN_AUDIENCE") == "" {
		t.Errorf("the verifier identity env must stay set (the function refuses by missing keys, not by missing identity): %+v", env)
	}
}

// --- the verdict ------------------------------------------------------------

func jwksReadyKsvc() *servingv1.Service {
	return &servingv1.Service{Status: servingv1.ServiceStatus{Status: duckv1.Status{Conditions: duckv1.Conditions{{
		Type: apis.ConditionReady, Status: corev1.ConditionTrue,
	}}}}}
}

// acceptedObservation is a bound, compliant, rendered and Ready function.
func acceptedObservation(state zoneJWKSState, detail string) functionObservation {
	return functionObservation{
		zone: jwksZone(), zoneListed: true, ksvc: jwksReadyKsvc(), jwks: state, jwksDetail: detail,
	}
}

func jwksBS() *appsv1alpha1.BackendService {
	return &appsv1alpha1.BackendService{
		ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: sovNS, Generation: 3},
		Spec:       appsv1alpha1.BackendServiceSpec{Zone: "orders", Image: "img"},
	}
}

func verdictCondition(t *testing.T, v functionVerdict, typ string) metav1.Condition {
	t.Helper()
	c := apimeta.FindStatusCondition(v.conditions, typ)
	if c == nil {
		t.Fatalf("verdict has no %s condition: %+v", typ, v.conditions)
	}
	return *c
}

func TestVerdictUntrustedJWKSIsFalseNotReadyAndWarns(t *testing.T) {
	v := computeBackendServiceVerdict(jwksBS(), acceptedObservation(zoneJWKSUntrusted, "it has no controller ownerReference"))

	c := verdictCondition(t, v, ConditionJWKSTrusted)
	if c.Status != metav1.ConditionFalse || c.Reason != ReasonJWKSUntrusted {
		t.Fatalf("JWKSTrusted = %s/%s, want False/%s", c.Status, c.Reason, ReasonJWKSUntrusted)
	}
	for _, want := range []string{`"orders-knext-jwks"`, "not controlled", "no controller ownerReference", "NOT mounted", "health"} {
		if !strings.Contains(c.Message, want) {
			t.Errorf("JWKSTrusted message %q lacks %q", c.Message, want)
		}
	}
	ready := verdictCondition(t, v, ConditionReady)
	if ready.Status != metav1.ConditionFalse || ready.Reason != ReasonJWKSUntrusted {
		t.Fatalf("Ready = %s/%s, want False/%s: a function that refuses every call is not Ready", ready.Status, ready.Reason, ReasonJWKSUntrusted)
	}
	if len(v.events) != 1 || v.events[0].eventType != corev1.EventTypeWarning || v.events[0].reason != ReasonJWKSUntrusted {
		t.Fatalf("want exactly one Warning %s event, got %+v", ReasonJWKSUntrusted, v.events)
	}
	if v.refusal != ReasonJWKSUntrusted {
		t.Errorf("refusal = %q, want %q (the refusals metric counts the transition)", v.refusal, ReasonJWKSUntrusted)
	}
}

func TestVerdictUntrustedJWKSWarnsOnTheTransitionOnly(t *testing.T) {
	bs := jwksBS()
	obs := acceptedObservation(zoneJWKSUntrusted, "it has no controller ownerReference")
	first := computeBackendServiceVerdict(bs, obs)
	for _, c := range first.conditions {
		apimeta.SetStatusCondition(&bs.Status.Conditions, c)
	}
	second := computeBackendServiceVerdict(bs, obs)
	if len(second.events) != 0 || second.refusal != "" {
		t.Fatalf("a converged untrusted function must not re-warn: events %+v refusal %q", second.events, second.refusal)
	}
	for i := range first.conditions {
		if first.conditions[i].Message != second.conditions[i].Message || first.conditions[i].Reason != second.conditions[i].Reason {
			t.Errorf("condition %s is not static across passes (a status write on every reconcile)", first.conditions[i].Type)
		}
	}
}

func TestVerdictAbsentJWKSIsUnknownAndDoesNotFailReady(t *testing.T) {
	v := computeBackendServiceVerdict(jwksBS(), acceptedObservation(zoneJWKSAbsent, ""))
	c := verdictCondition(t, v, ConditionJWKSTrusted)
	if c.Status != metav1.ConditionUnknown || c.Reason != ReasonJWKSNotPublished {
		t.Fatalf("JWKSTrusted = %s/%s, want Unknown/%s", c.Status, c.Reason, ReasonJWKSNotPublished)
	}
	if !strings.Contains(c.Message, "does not exist yet") || !strings.Contains(c.Message, "optional") {
		t.Errorf("message %q must say the ConfigMap does not exist yet and the mount is optional", c.Message)
	}
	if ready := verdictCondition(t, v, ConditionReady); ready.Status != metav1.ConditionTrue {
		t.Errorf("an absent JWKS is the normal first-minutes state and must not fail Ready: %+v", ready)
	}
	if len(v.events) != 0 || v.refusal != "" {
		t.Errorf("no warning for an absent JWKS: events %+v refusal %q", v.events, v.refusal)
	}
}

func TestVerdictControlledJWKSIsTrue(t *testing.T) {
	v := computeBackendServiceVerdict(jwksBS(), acceptedObservation(zoneJWKSControlled, ""))
	c := verdictCondition(t, v, ConditionJWKSTrusted)
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonJWKSControlled {
		t.Fatalf("JWKSTrusted = %s/%s, want True/%s", c.Status, c.Reason, ReasonJWKSControlled)
	}
	if ready := verdictCondition(t, v, ConditionReady); ready.Status != metav1.ConditionTrue {
		t.Errorf("Ready = %+v, want True", ready)
	}
}

func TestVerdictRefusedFunctionReportsItsOwnReasonNotTheJWKS(t *testing.T) {
	obs := acceptedObservation(zoneJWKSUntrusted, "it has no controller ownerReference")
	obs.zoneListed = false // refused: nothing is rendered, so nothing is mounted
	obs.ksvc = nil
	v := computeBackendServiceVerdict(jwksBS(), obs)
	if c := verdictCondition(t, v, ConditionJWKSTrusted); c.Status != metav1.ConditionUnknown || c.Reason != ReasonJWKSNotRendered {
		t.Errorf("JWKSTrusted = %s/%s, want Unknown/%s for a function that renders nothing", c.Status, c.Reason, ReasonJWKSNotRendered)
	}
	if ready := verdictCondition(t, v, ConditionReady); ready.Reason != ReasonZoneNotListed {
		t.Errorf("Ready reason = %q, want %q (the binding refusal outranks the JWKS)", ready.Reason, ReasonZoneNotListed)
	}
}

func TestVerdictRenderErrorOutranksUntrustedJWKS(t *testing.T) {
	obs := acceptedObservation(zoneJWKSUntrusted, "it has no controller ownerReference")
	obs.renderErr = "Knative Service \"pricing\" already exists and is controlled by Foo \"x\"; rename the function"
	obs.ksvc = nil
	v := computeBackendServiceVerdict(jwksBS(), obs)
	if ready := verdictCondition(t, v, ConditionReady); ready.Reason != ReasonKnativeServiceNameTaken {
		t.Errorf("Ready reason = %q, want %q: nothing was rendered, so the JWKS is moot", ready.Reason, ReasonKnativeServiceNameTaken)
	}
}

func TestVerdictUntrustedJWKSOutranksKnativeNotReady(t *testing.T) {
	obs := acceptedObservation(zoneJWKSUntrusted, "it has no controller ownerReference")
	obs.ksvc = &servingv1.Service{} // not Ready yet
	v := computeBackendServiceVerdict(jwksBS(), obs)
	if ready := verdictCondition(t, v, ConditionReady); ready.Reason != ReasonJWKSUntrusted {
		t.Errorf("Ready reason = %q, want %q: a policy fact outranks a transient wait", ready.Reason, ReasonJWKSUntrusted)
	}
}

func TestRefusalsMetricCarriesTheJWKSReasonFromStartUp(t *testing.T) {
	for _, r := range backendServiceRefusalReasons {
		if r == ReasonJWKSUntrusted {
			return
		}
	}
	t.Fatalf("backendServiceRefusalReasons lacks %q: the series would be absent until first used, which an alert reads as fine", ReasonJWKSUntrusted)
}
