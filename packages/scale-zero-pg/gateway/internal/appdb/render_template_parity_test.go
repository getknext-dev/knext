package appdb

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/yaml"
)

// render.go says of itself: "mirrors the template so the operator renders
// byte-compatible objects" and "mirrors the template Deployment exactly". Until
// now nothing checked that, and the claim had already decayed: the template
// gained CLOUD_ADMIN_MD5 (issue #112) and later JWT_JWK_KID/JWT_JWK_X (the
// ADR-0044 trust-anchor rotation) while render.go kept mounting only
// APP_ROLE_VERIFIER.
//
// Both design gates on the rotation PR flagged the same thing: the Go renderer
// is a FIFTH rendering path that the YAML-scanning guards cannot see, so drift
// there is silent. The divergence was fail-safe (an unmounted anchor means the
// entrypoint invents a throwaway one), but "fail-safe" is a property of today's
// entrypoint, not a guarantee about tomorrow's env.
//
// So this asserts the claim rather than trusting it: every env name the
// template's per-app compute container mounts must also be mounted by
// RenderDeployment, and vice versa. It compares NAMES, not values — the values
// legitimately differ (the template is a sed-substituted text template; the Go
// path builds typed objects) and pinning them would make the guard noise.
func TestRenderDeploymentMatchesTemplateEnv(t *testing.T) {
	tmplEnv := templateComputeEnvNames(t)
	if len(tmplEnv) == 0 {
		t.Fatal("parsed no env names from the template — the guard would pass vacuously")
	}

	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderDeployment(ComputeSpec{App: "parity", TenantID: "t", TimelineID: "l"})
	goEnv := envRefs(dep.Spec.Template.Spec.Containers)
	if len(goEnv) == 0 {
		t.Fatal("RenderDeployment produced no env at all — the guard would pass vacuously")
	}

	missingInGo := difference(tmplEnv, goEnv)
	missingInTemplate := difference(goEnv, tmplEnv)

	if len(missingInGo) > 0 {
		t.Errorf("the template mounts env the Go renderer does not: %v\n"+
			"render.go claims to mirror deploy/compute-app.template.yaml exactly. Either mount "+
			"these in RenderDeployment, or delete the claim — a per-app compute rendered by the "+
			"operator would silently miss what a template-rendered one gets.", missingInGo)
	}
	if len(missingInTemplate) > 0 {
		t.Errorf("the Go renderer mounts env the template does not: %v\n"+
			"drift in the other direction is equally silent: the documented break-glass path "+
			"(provision-app.sh renders the template) would miss it.", missingInTemplate)
	}
}

// templateComputeEnvNames extracts env names from the template's per-app compute
// container. The template is a sed-substituted TEXT template, so its
// placeholders are not valid YAML values everywhere; the placeholders that
// matter here sit in scalar positions, so a plain unmarshal works. If that ever
// stops being true the parse fails loudly rather than silently returning few
// names — which the vacuity check above also covers.
// envRefs describes each env as "NAME" or, for a secretKeyRef,
// "NAME<-secret/KEY". Comparing the REFERENCE and not just the name is what
// makes the guard catch a wrong Secret: code review mutation-proved that with a
// names-only comparison, changing pg-cloud-admin to pg-WRONG-secret still
// passed — and because these refs are optional, a wrong name silently yields
// NOTHING at runtime, which is indistinguishable from working. The Secret name
// and key are static literals on both sides (only app-db-<app> is templated,
// and the template's placeholder is substituted below), so an exact comparison
// is legitimate here.
func envRefs(containers []corev1.Container) []string {
	var out []string
	for _, c := range containers {
		for _, e := range c.Env {
			if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
				out = append(out, e.Name+"<-"+e.ValueFrom.SecretKeyRef.Name+"/"+e.ValueFrom.SecretKeyRef.Key)
				continue
			}
			out = append(out, e.Name)
		}
	}
	return out
}

func templateComputeEnvNames(t *testing.T) []string {
	t.Helper()
	// gateway/internal/appdb -> packages/scale-zero-pg/deploy
	path := filepath.Join("..", "..", "..", "deploy", "compute-app.template.yaml")
	rawBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read the template (%s): %v", path, err)
	}
	// The template is sed-substituted at provision time; the Go renderer builds
	// the same value from ComputeSpec.App. Substitute so the two are comparable.
	raw := strings.ReplaceAll(string(rawBytes), "__APP__", "parity")

	var names []string
	for _, doc := range strings.Split(raw, "\n---") {
		var obj struct {
			Kind string `json:"kind"`
			Spec struct {
				Template struct {
					Spec struct {
						Containers []struct {
							Name string          `json:"name"`
							Env  []corev1.EnvVar `json:"env"`
						} `json:"containers"`
					} `json:"spec"`
				} `json:"template"`
			} `json:"spec"`
		}
		// sigs.k8s.io/yaml converts YAML to JSON and decodes with the k8s types
		// own JSON tags. gopkg.in/yaml.v3 lowercases field names instead, so
		// `valueFrom` never mapped to ValueFrom and every secretKeyRef silently
		// vanished — the guard found that bug in ITSELF once it started
		// comparing references rather than names.
		if err := yaml.Unmarshal([]byte(doc), &obj); err != nil {
			// A document that does not parse as a Deployment is not necessarily a
			// failure (the template carries several kinds), but a Deployment that
			// does not parse would silently shrink the expected set — so only skip
			// documents that are not Deployments.
			if strings.Contains(doc, "kind: Deployment") {
				t.Fatalf("the template's Deployment did not parse, so the expected env set "+
					"would be silently short: %v", err)
			}
			continue
		}
		if obj.Kind != "Deployment" {
			continue
		}
		// Convert to corev1.Container so ONE descriptor function serves both
		// sides — a second implementation could agree with itself while diverging
		// from the renderer, which is the very failure this file exists to catch.
		var cs []corev1.Container
		for _, c := range obj.Spec.Template.Spec.Containers {
			cs = append(cs, corev1.Container{Name: c.Name, Env: c.Env})
		}
		names = append(names, envRefs(cs)...)
	}
	return names
}

func difference(a, b []string) []string {
	inB := make(map[string]bool, len(b))
	for _, s := range b {
		inB[s] = true
	}
	var out []string
	for _, s := range a {
		if !inB[s] {
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// The per-app READ-REPLICA renderer has no template to compare against — the
// only RO manifest is deploy/26-compute-ro.yaml, which is the BASE tier and
// legitimately uses a different credential (pg-base-admin rather than the
// per-app pg-cloud-admin). So the parity guard above structurally cannot see
// it, and code review found the identical drift here right after it was closed
// on the writer: per-app read replicas were booting with a throwaway
// control-API anchor while their writer used the cluster's real one.
//
// The invariant that DOES hold: a per-app reader and its per-app writer run the
// same entrypoint family against the same cluster Secrets, so every
// secret-backed env on the writer must also be on the reader. Asserted here
// rather than left to the next reviewer to notice.
func TestRenderRODeploymentCarriesTheWritersSecretEnv(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	spec := ComputeSpec{App: "parity", TenantID: "t", TimelineID: "l"}

	writer := envRefs(c.RenderDeployment(spec).Spec.Template.Spec.Containers)
	roSpec := ROComputeSpec{App: spec.App, TenantID: spec.TenantID, TimelineID: spec.TimelineID}
	reader := envRefs(c.RenderRODeployment(roSpec).Spec.Template.Spec.Containers)

	// APP_ROLE_VERIFIER is the ONE writer secret a reader legitimately does not
	// need: the app role's SCRAM verifier reaches a replica through the
	// REPLICATED CATALOG (streamed from the primary via WAL), so injecting it
	// again would be redundant, not protective. Every other writer secret is a
	// cluster credential the reader consumes identically. Exempting exactly one
	// thing, with the reason, rather than weakening the whole assertion.
	var writerSecrets []string
	for _, r := range writer {
		if !strings.Contains(r, "<-") || strings.HasPrefix(r, "APP_ROLE_VERIFIER<-") {
			continue
		}
		writerSecrets = append(writerSecrets, r)
	}
	if len(writerSecrets) == 0 {
		t.Fatal("the writer mounts no secret-backed env — the guard would pass vacuously")
	}
	if missing := difference(writerSecrets, reader); len(missing) > 0 {
		t.Errorf("the per-app read replica does not mount secret env its writer does: %v\n"+
			"both are per-app computes on the same entrypoint family; a reader booting "+
			"without these gets a throwaway control-API anchor and an unstable cloud_admin "+
			"md5 while its writer does not.", missing)
	}
}

// Blind spots, recorded rather than left implicit: the comparisons above read
// container `env` only. `envFrom` (the compute-config ConfigMap) and
// `initContainers` are NOT compared — they are currently identical on both
// sides, so asserting them would add no signal today, but a future divergence
// there would be as invisible as the one this file exists to catch. Asserted
// minimally so the assumption fails loudly if it stops holding.
func TestParityGuardBlindSpotsStayEmpty(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	spec := ComputeSpec{App: "parity", TenantID: "t", TimelineID: "l"}
	roSpec := ROComputeSpec{App: spec.App, TenantID: spec.TenantID, TimelineID: spec.TimelineID}
	writer := c.RenderDeployment(spec)
	reader := c.RenderRODeployment(roSpec)

	// envFrom: asserted, not merely documented. Code review left this as the one
	// residual nit and it is cheap to close — a guard that names a blind spot
	// without asserting it is the same "documented expectation degrades" shape
	// this repo keeps re-learning. Both renderers must pull the SAME ConfigMaps,
	// or a per-app compute silently loses (or gains) its whole config surface.
	envFromNames := func(cs []corev1.Container) []string {
		var out []string
		for _, ct := range cs {
			for _, ef := range ct.EnvFrom {
				if ef.ConfigMapRef != nil {
					out = append(out, "cm/"+ef.ConfigMapRef.Name)
				}
				if ef.SecretRef != nil {
					out = append(out, "secret/"+ef.SecretRef.Name)
				}
			}
		}
		sort.Strings(out)
		return out
	}
	wf := envFromNames(writer.Spec.Template.Spec.Containers)
	rf := envFromNames(reader.Spec.Template.Spec.Containers)
	if len(wf) == 0 {
		t.Fatal("the writer pulls no envFrom at all — the assertion would be vacuous")
	}
	if diff := difference(wf, rf); len(diff) > 0 {
		t.Errorf("the reader does not pull envFrom the writer does: %v", diff)
	}
	if diff := difference(rf, wf); len(diff) > 0 {
		t.Errorf("the reader pulls envFrom the writer does not: %v", diff)
	}

	writerICs := writer.Spec.Template.Spec.InitContainers
	readerICs := reader.Spec.Template.Spec.InitContainers
	for name, ics := range map[string][]corev1.Container{"writer": writerICs, "reader": readerICs} {
		for _, ic := range ics {
			if len(ic.Env) > 0 {
				t.Errorf("%s initContainer %q now carries env (%d vars) — the parity guard does "+
					"not compare initContainer env, so extend it before relying on this", name, ic.Name, len(ic.Env))
			}
		}
	}
}
