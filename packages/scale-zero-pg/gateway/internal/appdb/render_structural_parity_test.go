package appdb

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/yaml"
)

// T8 (#1102): promote the render<->template parity guard from a NAME-LIST check to
// a STRUCTURAL projection diff of the whole per-app compute PodSpec.
//
// Why this file exists on top of render_template_parity_test.go (env names) and
// render_tls_parity_test.go (F5 volume/mount names): both of those compare NAME
// LISTS. That is exactly how the F5 mTLS gap (#1093/#1094) shipped — the env-name
// guard was blind to the missing TLS volume mounts, so operator-provisioned per-app
// computes ran plaintext. #1094 added a volume/mount NAME check, but a future
// securityContext / probe / command / resource-shape drift is still invisible to a
// name-list comparison. render.go says of itself it "mirrors the template Deployment
// exactly"; this asserts that structurally rather than trusting it.
//
// The comparison is a canonical FACET projection of the PodSpec: command, args
// count, envFrom, env refs, volume mounts (name+path+readOnly), volumes
// (name+source+optional+items), ports, probes, container/pod securityContext, and
// resource-key PRESENCE. It compares STRUCTURE/keys, deliberately NOT values, with
// an explicit allowlist of the value classes that legitimately differ between a
// sed-substituted TEXT template and typed Go objects:
//
//   ALLOWLIST (value classes intentionally not compared, each legitimate):
//     1. Resource QUANTITIES. The template carries __CPU_REQ__/__CPU_LIM__/
//        __MEM_REQ__/__MEM_LIM__ placeholders (substituted by provision-app.sh);
//        render.go resolves them from per-app quotas. Only the resource KEY set
//        (cpu/memory/ephemeral-storage under requests vs limits) is compared, not
//        the amounts — pinning amounts would make the guard noise.
//     2. Per-app SUBSTITUTED names. app-db-__APP__ / compute-config-__APP__ /
//        compute-__APP__ are templated; the parser substitutes __APP__->parity so
//        both sides render the same concrete name, then compares.
//     3. Shell SCRIPT text of initContainer args. The template is an indented YAML
//        block scalar; render.go is a dedented Go raw string — same script, different
//        leading whitespace. Only the ARG COUNT is compared, plus the exact command
//        (["/bin/sh","-c"] vs ["/bin/sh","/compute-files/entrypoint.sh"]), which is
//        what a "wrong entrypoint" mutation would corrupt.
//     4. Deployment-level fields (replicas, strategy, revisionHistoryLimit) — this
//        is a POD SPEC projection by construction; those are covered elsewhere and
//        legitimately differ (e.g. __REPLICAS__ placeholder).
//     5. resizePolicy — see TestResizePolicyIsKnownUnprojectedTemplateDrift below:
//        this one is NOT a legitimate difference, it is a REAL discovered drift,
//        excluded here only so the guard stays green against unchanged production.

// projectPodSpec renders a PodSpec into a sorted, comparable set of structural facet
// tokens. ONE function serves both the template and the Go renderer — a second
// implementation could agree with itself while diverging from the renderer, which is
// the failure this whole file family exists to catch.
func projectPodSpec(ps corev1.PodSpec) []string {
	var out []string

	// Pod-level securityContext (seccomp is the field the template sets; describe the
	// whole thing so a REMOVED securityContext drops the token and reds the diff).
	if sc := ps.SecurityContext; sc != nil {
		if sc.SeccompProfile != nil {
			out = append(out, "pod/securityContext/seccomp="+string(sc.SeccompProfile.Type))
		} else {
			out = append(out, "pod/securityContext=present")
		}
		if sc.RunAsNonRoot != nil {
			out = append(out, "pod/securityContext/runAsNonRoot="+strconv.FormatBool(*sc.RunAsNonRoot))
		}
	}

	for _, v := range ps.Volumes {
		out = append(out, "pod/volume="+describeVolume(v))
	}

	projectContainers := func(kind string, cs []corev1.Container) {
		for _, c := range cs {
			key := "c/" + kind + "/" + c.Name
			out = append(out, key+"/command="+strings.Join(c.Command, " "))
			out = append(out, key+"/args#="+strconv.Itoa(len(c.Args)))
			for _, ef := range c.EnvFrom {
				if ef.ConfigMapRef != nil {
					out = append(out, key+"/envFrom=cm/"+ef.ConfigMapRef.Name)
				}
				if ef.SecretRef != nil {
					out = append(out, key+"/envFrom=secret/"+ef.SecretRef.Name)
				}
			}
			// envRefs (shared with the env-name guard) already encodes NAME<-secret/KEY
			// for secretKeyRefs and NAME for plain values — one token per env so a
			// single deleted env ref drops exactly one facet.
			for _, ref := range envRefs([]corev1.Container{c}) {
				out = append(out, key+"/env="+ref)
			}
			for _, vm := range c.VolumeMounts {
				out = append(out, key+"/mount="+vm.Name+"|"+vm.MountPath+"|ro="+strconv.FormatBool(vm.ReadOnly))
			}
			for _, p := range c.Ports {
				out = append(out, key+"/port="+p.Name+"|"+strconv.Itoa(int(p.ContainerPort)))
			}
			if c.ReadinessProbe != nil {
				out = append(out, key+"/probe/readiness="+describeProbe(c.ReadinessProbe))
			}
			if c.LivenessProbe != nil {
				out = append(out, key+"/probe/liveness="+describeProbe(c.LivenessProbe))
			}
			if c.StartupProbe != nil {
				out = append(out, key+"/probe/startup="+describeProbe(c.StartupProbe))
			}
			if c.SecurityContext != nil {
				out = append(out, key+"/securityContext=present")
			}
			// Resource KEY PRESENCE only (values are allowlisted class 1).
			out = append(out, key+"/resources/req="+sortedResourceKeys(c.Resources.Requests))
			out = append(out, key+"/resources/lim="+sortedResourceKeys(c.Resources.Limits))
		}
	}
	projectContainers("init", ps.InitContainers)
	projectContainers("main", ps.Containers)

	sort.Strings(out)
	return out
}

func describeVolume(v corev1.Volume) string {
	switch {
	case v.Secret != nil:
		opt := "false"
		if v.Secret.Optional != nil {
			opt = strconv.FormatBool(*v.Secret.Optional)
		}
		var items []string
		for _, it := range v.Secret.Items {
			items = append(items, it.Key)
		}
		sort.Strings(items)
		return v.Name + "|secret/" + v.Secret.SecretName + "|opt=" + opt + "|items=" + strings.Join(items, ",")
	case v.ConfigMap != nil:
		return v.Name + "|cm/" + v.ConfigMap.Name
	case v.EmptyDir != nil:
		return v.Name + "|emptyDir"
	default:
		return v.Name + "|<other>"
	}
}

func describeProbe(p *corev1.Probe) string {
	var handler string
	switch {
	case p.TCPSocket != nil:
		handler = "tcp:" + p.TCPSocket.Port.String()
	case p.HTTPGet != nil:
		handler = "http:" + p.HTTPGet.Path + ":" + p.HTTPGet.Port.String()
	case p.Exec != nil:
		handler = "exec:" + strings.Join(p.Exec.Command, " ")
	default:
		handler = "<none>"
	}
	return handler +
		"|id=" + strconv.Itoa(int(p.InitialDelaySeconds)) +
		"|p=" + strconv.Itoa(int(p.PeriodSeconds)) +
		"|ft=" + strconv.Itoa(int(p.FailureThreshold))
}

func sortedResourceKeys(rl corev1.ResourceList) string {
	var keys []string
	for k := range rl {
		keys = append(keys, string(k))
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}

// parseTemplateComputeDeployment parses the per-app WRITER Deployment out of
// deploy/compute-app.template.yaml into a typed appsv1.Deployment. The template is
// a sed-substituted TEXT template whose placeholders are not all valid typed values
// (replicas / resource quantities), so it substitutes concrete valid stand-ins first
// — arbitrary but valid, since the structural projection compares KEYS not amounts.
// A template that fails to parse, or that yields no Deployment, fails LOUDLY so the
// guard can never pass vacuously.
func parseTemplateComputeDeployment(t *testing.T) *appsv1.Deployment {
	t.Helper()
	path := filepath.Join("..", "..", "..", "deploy", "compute-app.template.yaml")
	rawBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read the template (%s): %v", path, err)
	}
	sub := strings.NewReplacer(
		"__APP__", "parity",
		"__TENANT_ID__", "tenant",
		"__TIMELINE_ID__", "timeline",
		"__REPLICAS__", "0",
		"__MAX_CONNS__", "100",
		"__CPU_REQ__", "250m",
		"__CPU_LIM__", "1000m",
		"__MEM_REQ__", "256Mi",
		"__MEM_LIM__", "1Gi",
	)
	raw := sub.Replace(string(rawBytes))

	var found *appsv1.Deployment
	for _, doc := range strings.Split(raw, "\n---") {
		if strings.TrimSpace(doc) == "" {
			continue
		}
		var head struct {
			Kind string `json:"kind"`
		}
		if err := yaml.Unmarshal([]byte(doc), &head); err != nil {
			// A non-Deployment doc that fails to parse is not fatal (the template
			// carries several kinds), but a Deployment that does not parse would
			// silently shrink the expected set.
			if strings.Contains(doc, "kind: Deployment") {
				t.Fatalf("the template's Deployment did not parse: %v", err)
			}
			continue
		}
		if head.Kind != "Deployment" {
			continue
		}
		var dep appsv1.Deployment
		if err := yaml.Unmarshal([]byte(doc), &dep); err != nil {
			t.Fatalf("the template's Deployment did not parse into appsv1.Deployment: %v", err)
		}
		found = &dep
	}
	if found == nil {
		t.Fatal("no Deployment found in the template — the guard would pass vacuously")
	}
	return found
}

func computeContainer(t *testing.T, ps corev1.PodSpec) corev1.Container {
	t.Helper()
	for _, c := range ps.Containers {
		if c.Name == "compute" {
			return c
		}
	}
	t.Fatal("no container named \"compute\" in the pod spec")
	return corev1.Container{}
}

func containsStr(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

// TestRenderDeploymentStructurallyMatchesTemplate is the T8 guard: the whole per-app
// WRITER PodSpec render.go emits must structurally match the template's, facet for
// facet, with only allowlisted value classes differing. A securityContext / probe /
// command / mount / volume / env-ref drift in either direction reds this — the class
// of drift the name-list guards could not see.
func TestRenderDeploymentStructurallyMatchesTemplate(t *testing.T) {
	tmpl := parseTemplateComputeDeployment(t)
	tmplProj := projectPodSpec(tmpl.Spec.Template.Spec)
	if len(tmplProj) == 0 {
		t.Fatal("template projection is empty — the guard would pass vacuously")
	}
	// Non-vacuity anchor: the compute container itself must have been projected, so a
	// parser that silently dropped it cannot leave a trivially-satisfiable set.
	const anchor = "c/main/compute/command=/bin/sh /compute-files/entrypoint.sh"
	if !containsStr(tmplProj, anchor) {
		t.Fatalf("template projection missing the compute-command anchor %q — the parser drifted; projection=%v", anchor, tmplProj)
	}

	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderDeployment(ComputeSpec{App: "parity", TenantID: "tenant", TimelineID: "timeline"})
	goProj := projectPodSpec(dep.Spec.Template.Spec)
	if len(goProj) == 0 {
		t.Fatal("render projection is empty — the guard would pass vacuously")
	}

	if miss := difference(tmplProj, goProj); len(miss) > 0 {
		t.Errorf("structural facets the TEMPLATE declares but render.go does NOT emit: %v\n"+
			"render.go claims to mirror deploy/compute-app.template.yaml exactly. Either emit "+
			"these in RenderDeployment, add them to the documented allowlist if the difference is "+
			"legitimate, or delete the mirror claim — an operator-provisioned per-app compute would "+
			"silently miss what a template-rendered one gets (this is how #1093 shipped).", miss)
	}
	if extra := difference(goProj, tmplProj); len(extra) > 0 {
		t.Errorf("structural facets render.go emits but the TEMPLATE does NOT declare: %v\n"+
			"drift in the other direction is equally silent — the documented break-glass path "+
			"(provision-app.sh renders the template) would miss it.", extra)
	}
}

// TestResizePolicyIsKnownUnprojectedTemplateDrift RECORDS a real drift discovered
// while building the structural guard, rather than silently fixing production (out of
// scope for a guard-strengthening task) or reddening CI with it.
//
// FINDING: the template's compute container declares
//
//	resizePolicy:
//	  - { resourceName: cpu, restartPolicy: NotRequired }
//	  - { resourceName: memory, restartPolicy: NotRequired }
//
// so the shared writer-autoscaler can vertically resize a per-app writer IN PLACE
// (no restart). render.go's RenderDeployment sets NO resizePolicy, so an
// operator-provisioned per-app writer would RESTART on a resize instead. That is the
// same class as the F5 mTLS gap (#1093/#1094): a real render<->template divergence a
// name-list guard cannot see. It is deliberately EXCLUDED from the structural
// projection above (allowlist class 5) only so the guard stays green against unchanged
// production; it is NOT a legitimate difference.
//
// This test proves the drift is real (so the report is not speculation) and acts as a
// tripwire: the day render.go is fixed to add resizePolicy, this test reds with an
// instruction to fold resizePolicy into the projection and delete this record.
func TestResizePolicyIsKnownUnprojectedTemplateDrift(t *testing.T) {
	tmpl := parseTemplateComputeDeployment(t)
	tmplCompute := computeContainer(t, tmpl.Spec.Template.Spec)
	if len(tmplCompute.ResizePolicy) == 0 {
		t.Fatal("expected the template compute container to declare resizePolicy; if it was removed, " +
			"update the structural-guard allowlist note (class 5) accordingly")
	}

	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderDeployment(ComputeSpec{App: "parity", TenantID: "tenant", TimelineID: "timeline"})
	goCompute := computeContainer(t, dep.Spec.Template.Spec)
	if len(goCompute.ResizePolicy) != 0 {
		t.Fatalf("render.go now sets resizePolicy (%v) — the known render<->template drift is FIXED. "+
			"Add resizePolicy to projectPodSpec's projection (drop allowlist class 5) and delete this "+
			"characterization test.", goCompute.ResizePolicy)
	}
}

// RO structural parity: recorded blind spot, deliberately not closed here.
//
// The per-app READ REPLICA (RenderRODeployment) has NO dedicated template to diff
// against — the only RO manifest, deploy/26-compute-ro.yaml, is the BASE tier and
// legitimately differs (base credential, RO_MODE=Replica, ro-lsn init + volume,
// RollingUpdate, replica-sized ephemeral storage), so a strict structural parity
// against it would false-positive on every legitimate base-vs-per-app difference.
// Building a curated RO allowlist large enough to be non-vacuous yet tight enough to
// still catch drift was judged higher false-positive risk than value here, so the RO
// structural check remains the EXISTING focused assertions:
//   - render_tls_parity_test.go:TestRenderRODeploymentMountsBackendTLS (F5 TLS mounts)
//   - render_template_parity_test.go:TestRenderRODeploymentCarriesTheWritersSecretEnv
//     (every per-app writer secret env is on the reader)
//   - render_template_parity_test.go:TestParityGuardBlindSpotsStayEmpty (envFrom + no
//     initContainer env)
//
// A FUTURE structural field added to the RO render that is NOT one of the above stays
// a blind spot; recorded here so it fails loudly to a reader rather than silently.
func TestRenderRODeploymentStructuralParityBlindSpotRecorded(t *testing.T) {
	// Non-vacuous sanity: the RO reader still projects to a non-empty structural set,
	// so the focused assertions above have a real object to guard. If this ever yields
	// nothing, the RO renderer was gutted and the focused guards pass vacuously.
	c := DefaultRenderConfig("scale-zero-pg")
	ro := c.RenderRODeployment(ROComputeSpec{App: "parity", TenantID: "tenant", TimelineID: "timeline"})
	if len(projectPodSpec(ro.Spec.Template.Spec)) == 0 {
		t.Fatal("RO reader projects to an empty structural set — the focused RO guards would be vacuous")
	}
}
