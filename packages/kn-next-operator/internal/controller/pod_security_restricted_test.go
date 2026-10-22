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

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	podsecurityapi "k8s.io/pod-security-admission/api"
	"k8s.io/pod-security-admission/policy"
	"k8s.io/utils/ptr"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// POD SECURITY `restricted`, BY DEFAULT, ON EVERY RENDERED POD.
//
// Every pod the operator renders for a NextApp or a BackendService has to be
// admitted in a namespace labelled pod-security.kubernetes.io/enforce=restricted.
// The check here is the Kubernetes project's own policy evaluator (the library
// the admission plugin itself runs), not a hand-written list of the four fields
// the profile mostly cares about: a rule the profile adds in a later Kubernetes
// release shows up here when the library is bumped.
//
// Two facts about Knative shape what is rendered, both read from the vendored
// knative.dev/serving source:
//
//  1. The ksvc webhook DISALLOWS a pod-level securityContext unless the cluster
//     admin turns on the non-default `kubernetes.podspec-securitycontext` flag.
//     The context is therefore rendered on the CONTAINER, where the webhook always
//     accepts runAsNonRoot, seccompProfile, allowPrivilegeEscalation and
//     capabilities.drop. The restricted profile accepts either level.
//  2. Knative adds the queue-proxy sidecar after the operator has rendered; the
//     operator does not control its context. The pod the evaluator sees here is
//     therefore the user container plus a queue-proxy carrying the context Knative
//     itself gives it (queueSecurityContext in the vendored queue.go).

// knativeQueueProxy mirrors the queue-proxy container Knative adds to every
// revision pod: knative.dev/serving pkg/reconciler/revision/resources/queue.go,
// `queueSecurityContext`. Only the fields the profile reads are reproduced.
func knativeQueueProxy() corev1.Container {
	return corev1.Container{
		Name:  "queue-proxy",
		Image: "gcr.io/knative-releases/knative.dev/serving/cmd/queue@sha256:0000",
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: ptr.To(false),
			ReadOnlyRootFilesystem:   ptr.To(true),
			RunAsNonRoot:             ptr.To(true),
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
			SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
	}
}

// revisionPodSpec is the pod spec a revision's Deployment carries: the template
// the operator rendered, plus the sidecar Knative adds.
func revisionPodSpec(ksvc *servingv1.Service) *corev1.PodSpec {
	spec := ksvc.Spec.Template.Spec.PodSpec.DeepCopy()
	spec.Containers = append(spec.Containers, knativeQueueProxy())
	return spec
}

// restrictedViolations runs the Kubernetes Pod Security `restricted` checks
// (latest version) over a pod spec and returns one line per violated check.
type fatalHelper interface {
	Helper()
	Fatalf(format string, args ...any)
}

func restrictedViolations(t fatalHelper, spec *corev1.PodSpec) []string {
	t.Helper()
	evaluator, err := policy.NewEvaluator(policy.DefaultChecks(), nil)
	if err != nil {
		t.Fatalf("building the Pod Security evaluator: %v", err)
	}
	lv := podsecurityapi.LevelVersion{Level: podsecurityapi.LevelRestricted, Version: podsecurityapi.LatestVersion()}
	results := evaluator.EvaluatePod(lv, &metav1.ObjectMeta{Name: "p", Namespace: "n"}, spec)
	var out []string
	for _, r := range results {
		if !r.Allowed {
			out = append(out, r.ForbiddenReason+": "+r.ForbiddenDetail)
		}
	}
	return out
}

// requireRestricted fails with every violation, so one run names all of them.
func requireRestricted(t *testing.T, spec *corev1.PodSpec) {
	t.Helper()
	if v := restrictedViolations(t, spec); len(v) != 0 {
		t.Fatalf("pod fails Pod Security restricted:\n  - %s", strings.Join(v, "\n  - "))
	}
}

// requireRestrictedContext asserts the four fields the profile turns on, by
// name, on one container. Each is checked separately so removing any one of them
// names itself in the failure instead of hiding behind the aggregate.
func requireRestrictedContext(t *testing.T, c corev1.Container, wantRunAsNonRoot bool) {
	t.Helper()
	sc := c.SecurityContext
	if sc == nil {
		t.Fatalf("container %q has no securityContext", c.Name)
	}
	if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Errorf("container %q: allowPrivilegeEscalation = %v, want false", c.Name, sc.AllowPrivilegeEscalation)
	}
	if sc.Capabilities == nil || len(sc.Capabilities.Drop) != 1 || sc.Capabilities.Drop[0] != "ALL" || len(sc.Capabilities.Add) != 0 {
		t.Errorf("container %q: capabilities = %+v, want drop [ALL] and nothing added", c.Name, sc.Capabilities)
	}
	if sc.SeccompProfile == nil || sc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Errorf("container %q: seccompProfile = %+v, want RuntimeDefault", c.Name, sc.SeccompProfile)
	}
	switch {
	case wantRunAsNonRoot && (sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot):
		t.Errorf("container %q: runAsNonRoot = %v, want true", c.Name, sc.RunAsNonRoot)
	case !wantRunAsNonRoot && sc.RunAsNonRoot != nil:
		t.Errorf("container %q: runAsNonRoot = %v, want it omitted (opt-out)", c.Name, *sc.RunAsNonRoot)
	}
}

// requireReadOnlyRoot asserts the app container still renders its own
// readOnlyRootFilesystem knob next to the profile fields.
func requireReadOnlyRoot(t *testing.T, c corev1.Container, want bool) {
	t.Helper()
	if sc := c.SecurityContext; sc == nil || sc.ReadOnlyRootFilesystem == nil || *sc.ReadOnlyRootFilesystem != want {
		t.Errorf("container %q: readOnlyRootFilesystem = %+v, want %v", c.Name, sc, want)
	}
}

func renderNextAppKsvc(t *testing.T, app *appsv1alpha1.NextApp) *servingv1.Service {
	t.Helper()
	sch := runtime.NewScheme()
	if err := appsv1alpha1.AddToScheme(sch); err != nil {
		t.Fatalf("AddToScheme(apps): %v", err)
	}
	if err := servingv1.AddToScheme(sch); err != nil {
		t.Fatalf("AddToScheme(serving): %v", err)
	}
	r := &NextAppReconciler{Scheme: sch}
	ksvc := &servingv1.Service{ObjectMeta: metav1.ObjectMeta{Name: app.Name, Namespace: app.Namespace}}
	if _, err := r.buildDesiredKsvc(app, ksvc, resolveEffective(app, nil)); err != nil {
		t.Fatalf("buildDesiredKsvc: %v", err)
	}
	return ksvc
}

const restrictedTestImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

func TestNextAppKsvcMeetsPodSecurityRestricted(t *testing.T) {
	cases := []struct {
		name string
		spec appsv1alpha1.NextAppSpec
	}{
		{"default standalone", appsv1alpha1.NextAppSpec{}},
		{"bun runtime", appsv1alpha1.NextAppSpec{Runtime: "bun"}},
		{"vinext single executable", appsv1alpha1.NextAppSpec{Build: "vinext"}},
		{"self-contained standalone", appsv1alpha1.NextAppSpec{SelfContained: true}},
		{"object storage (mounts the image cache)", appsv1alpha1.NextAppSpec{Storage: &appsv1alpha1.StorageSpec{Provider: "gcs", Bucket: "b"}}},
		{"writable cache (mounts /tmp and the image cache)", appsv1alpha1.NextAppSpec{Security: &appsv1alpha1.SecuritySpec{WritableCache: ptr.To(true)}}},
		{"read-only root filesystem opted out", appsv1alpha1.NextAppSpec{Security: &appsv1alpha1.SecuritySpec{ReadOnlyRootFilesystem: ptr.To(false)}}},
		{"private app", appsv1alpha1.NextAppSpec{Networking: &appsv1alpha1.NetworkingSpec{Visibility: appsv1alpha1.VisibilityClusterLocal}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.spec.Image = restrictedTestImage
			app := &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"}, Spec: tc.spec}
			ksvc := renderNextAppKsvc(t, app)

			containers := ksvc.Spec.Template.Spec.Containers
			if len(containers) != 1 {
				t.Fatalf("want exactly 1 rendered container, got %d", len(containers))
			}
			requireRestrictedContext(t, containers[0], true)
			wantRO := tc.spec.Security == nil || tc.spec.Security.ReadOnlyRootFilesystem == nil || *tc.spec.Security.ReadOnlyRootFilesystem
			requireReadOnlyRoot(t, containers[0], wantRO)
			requireRestricted(t, revisionPodSpec(ksvc))
		})
	}
}

// Knative's webhook rejects a pod-level securityContext on a stock install. The
// rendered template must therefore leave the pod-level context empty and carry
// the profile on the container — and must still pass Knative's own validation.
func TestNextAppKsvcPassesKnativeAdmissionWithRestrictedContext(t *testing.T) {
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec:       appsv1alpha1.NextAppSpec{Image: restrictedTestImage},
	}
	ksvc := renderNextAppKsvc(t, app)
	if ksvc.Spec.Template.Spec.SecurityContext != nil {
		t.Fatalf("pod-level securityContext rendered (%+v): Knative's webhook rejects it unless the cluster enables kubernetes.podspec-securitycontext", ksvc.Spec.Template.Spec.SecurityContext)
	}
	fetched := ksvc.DeepCopy()
	ctx := context.Background()
	fetched.SetDefaults(ctx)
	if err := fetched.Validate(ctx).Filter(apis.ErrorLevel); err != nil {
		t.Fatalf("Knative rejects the rendered Service: %v", err)
	}
}

// The reason the profile is rendered on the container and not the pod, pinned
// against the vendored Knative: on a default install its webhook rejects a
// pod-level securityContext outright. If this stops failing, Knative changed the
// default and the rendering decision in pod_hardening.go is worth revisiting.
func TestKnativeRejectsPodLevelSecurityContextByDefault(t *testing.T) {
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec:       appsv1alpha1.NextAppSpec{Image: restrictedTestImage},
	}
	ksvc := renderNextAppKsvc(t, app)
	ksvc.Spec.Template.Spec.SecurityContext = &corev1.PodSecurityContext{
		RunAsNonRoot:   ptr.To(true),
		SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
	}
	ctx := context.Background()
	ksvc.SetDefaults(ctx)
	err := ksvc.Validate(ctx).Filter(apis.ErrorLevel)
	if err == nil || !strings.Contains(err.Error(), "securityContext") {
		t.Fatalf("expected Knative to reject a pod-level securityContext on a default install, got %v", err)
	}
}

// The one opt-out. runAsNonRoot is the only part of the profile that depends on
// how the image was built, so it is the only part with a field.
func TestNextAppRunAsNonRootOptOut(t *testing.T) {
	cases := []struct {
		name     string
		security *appsv1alpha1.SecuritySpec
		want     bool
	}{
		{"nil security defaults ON", nil, true},
		{"nil field defaults ON", &appsv1alpha1.SecuritySpec{}, true},
		{"explicit true stays ON", &appsv1alpha1.SecuritySpec{RunAsNonRoot: ptr.To(true)}, true},
		{"explicit false omits runAsNonRoot", &appsv1alpha1.SecuritySpec{RunAsNonRoot: ptr.To(false)}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
				Spec:       appsv1alpha1.NextAppSpec{Image: restrictedTestImage, Security: tc.security},
			}
			ksvc := renderNextAppKsvc(t, app)
			c := ksvc.Spec.Template.Spec.Containers[0]
			requireRestrictedContext(t, c, tc.want)

			v := restrictedViolations(t, revisionPodSpec(ksvc))
			if tc.want && len(v) != 0 {
				t.Fatalf("default render fails restricted: %v", v)
			}
			if !tc.want {
				// The opt-out is honest: restricted is the very thing it gives up.
				if len(v) != 1 || !strings.Contains(v[0], "runAsNonRoot") {
					t.Fatalf("opting out of runAsNonRoot must fail exactly the runAsNonRoot check, got %v", v)
				}
			}
		})
	}
}

func renderedFunctionKsvc(t *testing.T, spec appsv1alpha1.BackendServiceSpec) *servingv1.Service {
	t.Helper()
	bs := sovFunction(spec)
	ksvc := &servingv1.Service{ObjectMeta: metav1.ObjectMeta{Name: bs.Name, Namespace: bs.Namespace}}
	if err := buildFunctionKsvc(bs, 0, zoneJWKSAbsent, ksvc); err != nil {
		t.Fatalf("buildFunctionKsvc: %v", err)
	}
	return ksvc
}

func TestBackendServiceKsvcMeetsPodSecurityRestricted(t *testing.T) {
	cases := []struct {
		name string
		spec appsv1alpha1.BackendServiceSpec
	}{
		{"defaults", appsv1alpha1.BackendServiceSpec{Image: restrictedTestImage}},
		{"custom port and scaling", appsv1alpha1.BackendServiceSpec{
			Image: restrictedTestImage, Port: 8081,
			Scaling: &appsv1alpha1.FunctionScalingSpec{MinScale: 1, MaxScale: 2, ContainerConcurrency: 10},
		}},
		{"emptyDir and secret volumes", appsv1alpha1.BackendServiceSpec{
			Image: restrictedTestImage,
			Volumes: []appsv1alpha1.FunctionVolume{
				{Name: "scratch", MountPath: "/scratch", EmptyDir: &corev1.EmptyDirVolumeSource{}},
				{Name: "creds", MountPath: "/creds", Secret: &corev1.SecretVolumeSource{SecretName: "creds"}},
			},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ksvc := renderedFunctionKsvc(t, tc.spec)
			containers := ksvc.Spec.Template.Spec.Containers
			if len(containers) != 1 {
				t.Fatalf("want exactly 1 rendered container, got %d", len(containers))
			}
			// A function has no opt-out: runAsNonRoot is always rendered.
			requireRestrictedContext(t, containers[0], true)
			requireRestricted(t, revisionPodSpec(ksvc))

			if ksvc.Spec.Template.Spec.SecurityContext != nil {
				t.Fatalf("pod-level securityContext rendered: Knative's webhook rejects it on a stock install")
			}
			fetched := ksvc.DeepCopy()
			ctx := context.Background()
			fetched.SetDefaults(ctx)
			if err := fetched.Validate(ctx).Filter(apis.ErrorLevel); err != nil {
				t.Fatalf("Knative rejects the rendered function Service: %v", err)
			}
		})
	}
}

// The checker has to be able to say no. These pods are what the operator
// rendered before the profile was applied; each must fail, and name the rule.
func TestRestrictedCheckerRejectsThePreviousRender(t *testing.T) {
	nextApp := &servingv1.Service{}
	nextApp.Spec.Template.Spec.Containers = []corev1.Container{{
		Name: "user-container", Image: restrictedTestImage,
		SecurityContext: &corev1.SecurityContext{ReadOnlyRootFilesystem: ptr.To(true)},
	}}
	function := &servingv1.Service{}
	function.Spec.Template.Spec.Containers = []corev1.Container{{
		Name: "user-container", Image: restrictedTestImage,
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: ptr.To(false),
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
	}}
	for name, tc := range map[string]struct {
		ksvc *servingv1.Service
		want []string
	}{
		"nextapp before":        {nextApp, []string{"allowPrivilegeEscalation", "unrestricted capabilities", "runAsNonRoot", "seccomp"}},
		"backendservice before": {function, []string{"runAsNonRoot", "seccomp"}},
	} {
		t.Run(name, func(t *testing.T) {
			joined := strings.Join(restrictedViolations(t, revisionPodSpec(tc.ksvc)), "\n")
			for _, w := range tc.want {
				if !strings.Contains(joined, w) {
					t.Errorf("checker did not report %q; reported:\n%s", w, joined)
				}
			}
		})
	}
}
