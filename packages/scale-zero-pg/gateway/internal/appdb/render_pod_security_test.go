package appdb

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	podsecurityapi "k8s.io/pod-security-admission/api"
	"k8s.io/pod-security-admission/policy"
)

// POD SECURITY `restricted` ON EVERY CONTAINER THE GATEWAY RENDERS.
//
// The per-app compute pods (writer and read replica) have to be admitted in a
// namespace labelled pod-security.kubernetes.io/enforce=restricted. The check is
// the Kubernetes project's own policy evaluator (the library the admission
// plugin runs) over the REAL render, not a hand-written list of the four fields
// the profile mostly cares about.
//
// The images name their user, not a number (`postgres` / `neon`, both uid 1000
// in the pinned digests, read from each image's /etc/passwd). The kubelet
// refuses runAsNonRoot on a non-numeric image user ("cannot verify user is
// non-root"), so the render pins the numeric uid/gid explicitly.

func restrictedViolations(t *testing.T, spec *corev1.PodSpec) []string {
	t.Helper()
	evaluator, err := policy.NewEvaluator(policy.DefaultChecks())
	if err != nil {
		t.Fatalf("building the Pod Security evaluator: %v", err)
	}
	lv := podsecurityapi.LevelVersion{Level: podsecurityapi.LevelRestricted, Version: podsecurityapi.LatestVersion()}
	var out []string
	for _, r := range evaluator.EvaluatePod(lv, &metav1.ObjectMeta{Name: "p", Namespace: "n"}, spec) {
		if !r.Allowed {
			out = append(out, r.ForbiddenReason+": "+r.ForbiddenDetail)
		}
	}
	return out
}

// requireContainerRestricted asserts the fields the profile turns on, by name,
// so removing any one of them names itself instead of hiding in the aggregate.
func requireContainerRestricted(t *testing.T, c corev1.Container) {
	t.Helper()
	sc := c.SecurityContext
	if sc == nil {
		t.Errorf("container %q has no securityContext", c.Name)
		return
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
	if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Errorf("container %q: runAsNonRoot = %v, want true", c.Name, sc.RunAsNonRoot)
	}
	// Numeric uid/gid: the images' USER is a name, which the kubelet cannot
	// verify as non-root.
	if sc.RunAsUser == nil || *sc.RunAsUser != 1000 {
		t.Errorf("container %q: runAsUser = %v, want 1000 (the postgres/neon uid in the pinned images)", c.Name, sc.RunAsUser)
	}
	if sc.RunAsGroup == nil || *sc.RunAsGroup != 1000 {
		t.Errorf("container %q: runAsGroup = %v, want 1000", c.Name, sc.RunAsGroup)
	}
}

func renderedComputePods(t *testing.T) map[string]*corev1.PodSpec {
	t.Helper()
	c := DefaultRenderConfig("scale-zero-pg")
	w := c.RenderDeployment(ComputeSpec{App: "shop", TenantID: "tenant-x", TimelineID: "timeline-y"})
	r := c.RenderRODeployment(ROComputeSpec{App: "shop", TenantID: "tenant-x", TimelineID: "timeline-y", MaxReplicas: 4})
	return map[string]*corev1.PodSpec{
		"writer":       &w.Spec.Template.Spec,
		"read replica": &r.Spec.Template.Spec,
	}
}

func TestComputePodsMeetPodSecurityRestricted(t *testing.T) {
	for name, spec := range renderedComputePods(t) {
		t.Run(name, func(t *testing.T) {
			if len(spec.InitContainers) == 0 || len(spec.Containers) == 0 {
				t.Fatalf("render has %d init / %d main containers; the guard would pass vacuously", len(spec.InitContainers), len(spec.Containers))
			}
			for _, c := range append(append([]corev1.Container{}, spec.InitContainers...), spec.Containers...) {
				requireContainerRestricted(t, c)
			}
			if v := restrictedViolations(t, spec); len(v) != 0 {
				t.Fatalf("pod fails Pod Security restricted:\n  - %s", strings.Join(v, "\n  - "))
			}
		})
	}
}

// The evaluator must actually be able to fail: the pre-hardening pod shape
// (pod-level seccomp only, no container securityContext) has to be reported, or
// the test above is decoration.
func TestRestrictedEvaluatorRejectsUnhardenedPod(t *testing.T) {
	for name, spec := range renderedComputePods(t) {
		t.Run(name, func(t *testing.T) {
			bare := spec.DeepCopy()
			for i := range bare.InitContainers {
				bare.InitContainers[i].SecurityContext = nil
			}
			for i := range bare.Containers {
				bare.Containers[i].SecurityContext = nil
			}
			if len(restrictedViolations(t, bare)) == 0 {
				t.Fatal("a pod with no container securityContext passed restricted: the evaluator wiring is broken")
			}
		})
	}
}

// An operator that overrides the compute or init image can override the uid the
// containers run as: the compute image's identity applies to the compute
// container only and the init image's to the init containers only, in both the
// writer and the read replica.
func TestRenderHonoursImageIdentityOverrides(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	c.ComputeUID, c.ComputeGID = 2001, 2002
	c.InitUID, c.InitGID = 3001, 3002
	w := c.RenderDeployment(ComputeSpec{App: "shop", TenantID: "t", TimelineID: "l"})
	r := c.RenderRODeployment(ROComputeSpec{App: "shop", TenantID: "t", TimelineID: "l", MaxReplicas: 2})
	for name, spec := range map[string]*corev1.PodSpec{"writer": &w.Spec.Template.Spec, "read replica": &r.Spec.Template.Spec} {
		for _, ic := range spec.InitContainers {
			sc := ic.SecurityContext
			if sc == nil || sc.RunAsUser == nil || *sc.RunAsUser != 3001 || sc.RunAsGroup == nil || *sc.RunAsGroup != 3002 {
				t.Errorf("%s init container %q: runAsUser/runAsGroup = %+v, want 3001/3002 (InitUID/InitGID)", name, ic.Name, sc)
			}
		}
		for _, mc := range spec.Containers {
			sc := mc.SecurityContext
			if sc == nil || sc.RunAsUser == nil || *sc.RunAsUser != 2001 || sc.RunAsGroup == nil || *sc.RunAsGroup != 2002 {
				t.Errorf("%s container %q: runAsUser/runAsGroup = %+v, want 2001/2002 (ComputeUID/ComputeGID)", name, mc.Name, sc)
			}
		}
	}
}

// The break-glass path (provision-app.sh renders deploy/compute-app.template.yaml)
// must meet the same profile, field for field, as the operator's render: the
// structural parity guard only sees that a securityContext is PRESENT.
func TestTemplateComputePodMeetsPodSecurityRestricted(t *testing.T) {
	dep := parseTemplateComputeDeployment(t)
	spec := &dep.Spec.Template.Spec
	if len(spec.InitContainers) == 0 || len(spec.Containers) == 0 {
		t.Fatalf("template has %d init / %d main containers; the guard would pass vacuously", len(spec.InitContainers), len(spec.Containers))
	}
	for _, c := range append(append([]corev1.Container{}, spec.InitContainers...), spec.Containers...) {
		requireContainerRestricted(t, c)
	}
	if v := restrictedViolations(t, spec); len(v) != 0 {
		t.Fatalf("template pod fails Pod Security restricted:\n  - %s", strings.Join(v, "\n  - "))
	}
}
