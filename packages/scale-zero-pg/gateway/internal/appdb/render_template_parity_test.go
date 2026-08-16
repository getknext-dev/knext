package appdb

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
	corev1 "k8s.io/api/core/v1"
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
	var goEnv []string
	for _, c := range dep.Spec.Template.Spec.Containers {
		for _, e := range c.Env {
			goEnv = append(goEnv, e.Name)
		}
	}
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
func templateComputeEnvNames(t *testing.T) []string {
	t.Helper()
	// gateway/internal/appdb -> packages/scale-zero-pg/deploy
	path := filepath.Join("..", "..", "..", "deploy", "compute-app.template.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read the template (%s): %v", path, err)
	}

	var names []string
	for _, doc := range strings.Split(string(raw), "\n---") {
		var obj struct {
			Kind string `yaml:"kind"`
			Spec struct {
				Template struct {
					Spec struct {
						Containers []struct {
							Name string          `yaml:"name"`
							Env  []corev1.EnvVar `yaml:"env"`
						} `yaml:"containers"`
					} `yaml:"spec"`
				} `yaml:"template"`
			} `yaml:"spec"`
		}
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
		for _, c := range obj.Spec.Template.Spec.Containers {
			for _, e := range c.Env {
				names = append(names, e.Name)
			}
		}
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
