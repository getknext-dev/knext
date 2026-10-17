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
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Revocation under an unreadable Secret, as pure functions. The reconciler-level
// proof (a revoked Secret does not stay mounted) is
// backendservice_revocation_envtest_test.go.

func TestClassifyReadError(t *testing.T) {
	forbidden := apierrors.NewForbidden(schema.GroupResource{Resource: "secrets"}, "s", errors.New("x"))
	cases := []struct {
		name string
		err  error
		want readClass
	}{
		{"timeout", apierrors.NewTimeoutError("x", 1), readTransient},
		{"server timeout", apierrors.NewServerTimeout(schema.GroupResource{}, "get", 1), readTransient},
		{"429", apierrors.NewTooManyRequests("x", 1), readTransient},
		{"500", apierrors.NewInternalError(errors.New("x")), readTransient},
		{"503", apierrors.NewServiceUnavailable("x"), readTransient},
		{"context deadline", fmt.Errorf("get: %w", context.DeadlineExceeded), readTransient},
		{"connection refused", &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, readTransient},
		{"unexpected EOF", io.ErrUnexpectedEOF, readTransient},
		{"url error", &url.Error{Op: "Get", URL: "https://x", Err: errors.New("http2: client connection lost")}, readTransient},
		{"forbidden", forbidden, readDenied},
		{"unauthorized", apierrors.NewUnauthorized("x"), readDenied},
		{"a bare 403 status", &apierrors.StatusError{ErrStatus: metav1.Status{Code: 403}}, readDenied},
		{"a bare 401 status", &apierrors.StatusError{ErrStatus: metav1.Status{Code: 401}}, readDenied},
		// The DEFAULT is held. None of these can tear a function down: nobody
		// anticipated them, and some an owner could provoke.
		{"an unrecognised error", errors.New("something nobody planned for"), readTransient},
		{"client-side name error", errors.New("resource name may not be empty"), readTransient},
		{"name is required", errors.New("name is required"), readTransient},
		{"bad request", apierrors.NewBadRequest("x"), readTransient},
		{"invalid", apierrors.NewInvalid(schema.GroupKind{Kind: "Secret"}, "s", nil), readTransient},
		{"conflict", apierrors.NewConflict(schema.GroupResource{}, "s", errors.New("x")), readTransient},
		{"gone", apierrors.NewResourceExpired("x"), readTransient},
	}
	for _, c := range cases {
		if got := classifyReadError(c.err); got != c.want {
			t.Errorf("%s: classified %d, want %d", c.name, got, c.want)
		}
	}
}

func TestSecretNameProblem(t *testing.T) {
	for _, bad := range []string{"", "..", "a/b", "UPPER", ".leading", "-leading", "trailing-", "has space", strings.Repeat("a", 254), "a..b"} {
		if secretNameProblem(bad) == "" {
			t.Errorf("%q must be refused as a Secret name", bad)
		}
	}
	for _, good := range []string{"stripe", "my-secret.v2", "a", strings.Repeat("a", 253), "orders-db-ro-dsn"} {
		if p := secretNameProblem(good); p != "" {
			t.Errorf("%q must be accepted, got %q", good, p)
		}
	}
}

func TestInvalidSecretNameIsAViolationNeverUnverified(t *testing.T) {
	zone, others := sovFixture()
	for _, name := range []string{"", "..", "a/b", "UPPER"} {
		// The lookup would report an unreadable Secret for any name; the name is
		// refused before it is ever looked up.
		got, unverified := checkFunctionSovereignty(sovFunction(specEnvFromSecret(name)), zone, others, readFails(name))
		if len(unverified) != 0 {
			t.Errorf("%q: an invalid name must not be held as unverified: %+v", name, unverified)
		}
		assertOneViolation(t, got, "envFrom[0].secretRef", name, "not a valid Secret name")
	}
}

// The only way a failed read can reach a verdict is through its NAME: the type
// has no "rejected" state to put an error in, and an unrecognised error is held.
func TestAFailedReadHasNoDefinitiveState(t *testing.T) {
	typ := reflect.TypeOf(secretMetadata{})
	for i := 0; i < typ.NumField(); i++ {
		switch typ.Field(i).Name {
		case "found", "labels", "ownerRefs", "readErr", "denied":
		default:
			t.Errorf("secretMetadata.%s: a failed read must not gain a state of its own; only the marks of an object that was READ, NotFound, or a name problem are definitive", typ.Field(i).Name)
		}
	}
}

func runningKsvc(spec corev1.PodSpec) *servingv1.Service {
	ksvc := &servingv1.Service{}
	ksvc.Spec.Template.Spec.PodSpec = spec
	return ksvc
}

func TestRunningSecretRefsCoversEverySource(t *testing.T) {
	ksvc := runningKsvc(corev1.PodSpec{
		InitContainers: []corev1.Container{{Name: "init", EnvFrom: []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "from-init"}}}}}},
		Containers: []corev1.Container{{
			Name: "user",
			Env: []corev1.EnvVar{{Name: "A", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: "from-key-ref"}, Key: "k"}}}},
			EnvFrom: []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "from-env-from"}}}},
		}},
		Volumes: []corev1.Volume{
			{Name: "v1", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: "from-volume"}}},
			{Name: "v2", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{Sources: []corev1.VolumeProjection{
				{Secret: &corev1.SecretProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "from-projected"}}}}}}},
			{Name: "cm", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "not-a-secret"}}}},
		},
	})
	var names []string
	for _, r := range runningSecretRefs(ksvc) {
		names = append(names, r.name)
		if !strings.Contains(r.source, "running Knative Service") {
			t.Errorf("source %q must say it is the running template", r.source)
		}
	}
	want := "from-init,from-key-ref,from-env-from,from-volume,from-projected"
	if got := strings.Join(names, ","); got != want {
		t.Errorf("running Secret refs = %s, want %s", got, want)
	}
}

func TestCheckRunningSovereigntyRefusesARevokedSecretAndIgnoresNoService(t *testing.T) {
	zone, others := sovFixture()
	bs := sovFunction(appsv1alpha1.BackendServiceSpec{})
	ksvc := runningKsvc(corev1.PodSpec{Containers: []corev1.Container{{
		Name:    "user",
		EnvFrom: []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "stripe"}}}},
	}}})
	revoked := sovSecrets(map[string]secretMetadata{"stripe": {labels: map[string]string{ZoneLabel: sovOther}}})
	got, _ := checkRunningSovereignty(bs, zone, others, revoked, ksvc)
	assertOneViolation(t, got, "the running Knative Service: container user envFrom[0].secretRef", "stripe", "marked for zone")

	if v, u := checkRunningSovereignty(bs, zone, others, revoked, nil); len(v) != 0 || len(u) != 0 {
		t.Errorf("no running Knative Service means nothing to check, got %+v %+v", v, u)
	}
	// An unreadable Secret in the running template is unverified, not a violation.
	_, u := checkRunningSovereignty(bs, zone, others, readFails("stripe"), ksvc)
	if len(u) != 1 || u[0].name != "stripe" {
		t.Errorf("want stripe unverified, got %+v", u)
	}
}

func TestEscalateDeniedSecretsOnlyAfterTheHold(t *testing.T) {
	now := time.Now()
	since := func(age time.Duration) *metav1.Time { t := metav1.NewTime(now.Add(-age)); return &t }
	unverified := []unverifiedSecret{
		{source: "envFrom[0].secretRef", name: "denied", err: "forbidden", denied: true},
		{source: "envFrom[1].secretRef", name: "flaky", err: "503"},
	}
	// Inside the hold: nothing changes.
	v, u := escalateDeniedSecrets(nil, unverified, since(time.Minute), now)
	if len(v) != 0 || len(u) != 2 {
		t.Errorf("inside the hold: violations=%+v unverified=%+v", v, u)
	}
	// Past the hold: the DENIED one is a violation, the transient one is still held.
	v, u = escalateDeniedSecrets(nil, unverified, since(2*secretsDeniedHold), now)
	if len(v) != 1 || v[0].name != "denied" || !strings.Contains(v[0].message, "denied access") {
		t.Errorf("past the hold: want the denied Secret refused, got %+v", v)
	}
	if len(u) != 1 || u[0].name != "flaky" {
		t.Errorf("past the hold: the transient Secret stays unverified, got %+v", u)
	}
	// No denial, no clock: nothing escalates, however old the transient error.
	if v, u := escalateDeniedSecrets(nil, unverified, nil, now); len(v) != 0 || len(u) != 2 {
		t.Errorf("no denial must mean no escalation, got %+v %+v", v, u)
	}
}

func TestNextDeniedSinceStartsAtTheFirstDenialAndClearsWithIt(t *testing.T) {
	now := time.Now()
	earlier := metav1.NewTime(now.Add(-7 * time.Minute))
	// The first denied pass starts the clock; transient-only passes never do.
	if got := nextDeniedSince(nil, false, now); got != nil {
		t.Errorf("no denial must not start the clock, got %v", got)
	}
	got := nextDeniedSince(nil, true, now)
	if got == nil || !got.Time.Equal(now) {
		t.Errorf("the first denial starts the clock now, got %v", got)
	}
	// The clock keeps its start while the denial lasts.
	if got := nextDeniedSince(&earlier, true, now); got == nil || !got.Time.Equal(earlier.Time) {
		t.Errorf("a persisting denial keeps its start, got %v", got)
	}
	// And it clears the first pass on which nothing is denied.
	if got := nextDeniedSince(&earlier, false, now); got != nil {
		t.Errorf("a denial that ended must clear the clock, got %v", got)
	}
}

func TestVerdictHoldsTheGenerationWhileUndecided(t *testing.T) {
	zone, _ := sovFixture()
	bs := sovFunction(appsv1alpha1.BackendServiceSpec{})
	bs.Generation = 3
	bs.Status.ObservedGeneration = 2
	running := runningKsvc(corev1.PodSpec{})
	o := functionObservation{zone: zone, zoneListed: true, ksvc: running, unverified: []unverifiedSecret{{name: "stripe"}}}

	v := computeBackendServiceVerdict(bs, o)
	if v.observedGeneration != 2 {
		t.Errorf("an undecided pass must not advance the observed generation, got %d", v.observedGeneration)
	}
	var ready metav1.Condition
	for _, c := range v.conditions {
		if c.Type == ConditionReady {
			ready = c
		}
	}
	if ready.Status != metav1.ConditionFalse || ready.Reason != ReasonSecretsUnverified {
		t.Errorf("Ready = %+v; a spec that could not be rolled out is not Ready", ready)
	}

	// The spec is the one last rolled out: the old Service's own state stands.
	bs.Status.ObservedGeneration = 3
	if v := computeBackendServiceVerdict(bs, o); v.observedGeneration != 3 {
		t.Errorf("observed generation = %d, want 3", v.observedGeneration)
	} else {
		for _, c := range v.conditions {
			if c.Type == ConditionReady && c.Reason == ReasonSecretsUnverified {
				t.Errorf("an unchanged spec keeps the running Service's own Ready, got %+v", c)
			}
		}
	}

	// A decided pass advances it.
	o.unverified = nil
	bs.Status.ObservedGeneration = 2
	if v := computeBackendServiceVerdict(bs, o); v.observedGeneration != 3 {
		t.Errorf("a decided pass observes the new generation, got %d", v.observedGeneration)
	}
}

// erroringReader answers every read with err.
type erroringReader struct{ err error }

func (e erroringReader) Get(context.Context, client.ObjectKey, client.Object, ...client.GetOption) error {
	return e.err
}

func (e erroringReader) List(context.Context, client.ObjectList, ...client.ListOption) error {
	return e.err
}

// The lookup the reconciler hands the allowlist maps each failed read onto
// exactly one of: unknown (held), denied (held for a bounded window), or
// rejected (a violation). NotFound stays "unmarked".
func TestSecretLookupMapsEachReadFailure(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantFound  bool
		wantReadEr bool
		wantDenied bool
	}{
		{"timeout", apierrors.NewTimeoutError("x", 1), false, true, false},
		{"forbidden", apierrors.NewForbidden(schema.GroupResource{Resource: "secrets"}, "s", errors.New("x")), false, true, true},
		{"unauthorized", apierrors.NewUnauthorized("x"), false, true, true},
		{"client-side", errors.New("name is required"), false, true, false},
		{"unrecognised", errors.New("something nobody planned for"), false, true, false},
		{"not found", apierrors.NewNotFound(schema.GroupResource{Resource: "secrets"}, "s"), false, false, false},
	}
	for _, c := range cases {
		r := &BackendServiceReconciler{APIReader: erroringReader{c.err}}
		got := r.secretMetadata(context.Background(), "ns")("s")
		if got.found != c.wantFound || (got.readErr != "") != c.wantReadEr || got.denied != c.wantDenied {
			t.Errorf("%s: got %+v", c.name, got)
		}
	}
}
