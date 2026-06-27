// Package install also verifies that the operator-managed Knative ingress-class
// (issue #45 / #46) is OVERRIDABLE rather than a permanently-hardcoded string. The
// bundle defaults to Kourier (kourier.ingress.networking.knative.dev) so a plain
// `kustomize build` yields a working Kourier install, but clusters whose Knative
// uses Istio or Contour must be able to swap the class without hand-editing the
// shipped manifest. The swap is performed by hack/set-ingress-class.sh, which
// rewrites the `ingress-class` key in a rendered bundle (mirroring the release-time
// digest substitution pattern). These tests pin that contract for 2nd-cloud
// portability (#46).
package install

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// istioIngressClass is the Knative controller-qualified ingress-class for net-istio.
const istioIngressClass = "istio.ingress.networking.knative.dev"

// setIngressClassScript is the override helper, relative to the operator package root.
const setIngressClassScript = "hack/set-ingress-class.sh"

// TestSetIngressClassScriptExists asserts the override mechanism ships as an
// executable helper — the ingress-class is not a take-it-or-leave-it hardcode.
func TestSetIngressClassScriptExists(t *testing.T) {
	p := filepath.Join("..", "..", setIngressClassScript)
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatalf("%s must exist so the Kourier ingress-class can be overridden for Istio/Contour clusters (#46): %v", setIngressClassScript, err)
	}
	if fi.Mode().Perm()&0o111 == 0 {
		t.Errorf("%s must be executable", setIngressClassScript)
	}
}

// TestSetIngressClassScriptDefaultsToKourier asserts that, run with no override, the
// helper keeps the Kourier default — so the out-of-box bundle is unchanged.
func TestSetIngressClassScriptDefaultsToKourier(t *testing.T) {
	in := configNetworkFixture(t, wantIngressClass)
	out := runSetIngressClass(t, in /* no override arg */)
	if got := ingressClassOf(t, out); got != wantIngressClass {
		t.Errorf("default run: ingress-class = %q, want Kourier default %q", got, wantIngressClass)
	}
}

// TestSetIngressClassScriptOverridesToIstio asserts an explicit override swaps the
// class to the Istio form, leaving the ConfigMap name/namespace intact.
func TestSetIngressClassScriptOverridesToIstio(t *testing.T) {
	in := configNetworkFixture(t, wantIngressClass)
	out := runSetIngressClass(t, in, istioIngressClass)
	if got := ingressClassOf(t, out); got != istioIngressClass {
		t.Errorf("override run: ingress-class = %q, want %q", got, istioIngressClass)
	}
	// name + namespace must be untouched (Serving reads config-network/knative-serving).
	if !strings.Contains(out, "name: "+wantConfigNetworkName) {
		t.Errorf("override must not rename the ConfigMap away from %q", wantConfigNetworkName)
	}
	if !strings.Contains(out, "namespace: "+wantKnativeNamespace) {
		t.Errorf("override must not move the ConfigMap out of %q", wantKnativeNamespace)
	}
}

// --- helpers ---

func configNetworkFixture(t *testing.T, class string) string {
	t.Helper()
	return strings.Join([]string{
		"apiVersion: v1",
		"kind: ConfigMap",
		"metadata:",
		"  name: " + wantConfigNetworkName,
		"  namespace: " + wantKnativeNamespace,
		"data:",
		"  ingress-class: " + class,
		"",
	}, "\n")
}

// runSetIngressClass writes `in` to a temp file, runs the helper (optionally with an
// override arg), and returns the rewritten file contents.
func runSetIngressClass(t *testing.T, in string, overrideArg ...string) string {
	t.Helper()
	script, err := filepath.Abs(filepath.Join("..", "..", setIngressClassScript))
	if err != nil {
		t.Fatalf("resolving script path: %v", err)
	}
	if _, err := os.Stat(script); err != nil {
		t.Skipf("%s not present yet: %v", setIngressClassScript, err)
	}
	f := filepath.Join(t.TempDir(), "install.yaml")
	if err := os.WriteFile(f, []byte(in), 0o644); err != nil {
		t.Fatalf("writing fixture: %v", err)
	}
	args := []string{f}
	args = append(args, overrideArg...)
	cmd := exec.Command(script, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("running %s: %v\n%s", setIngressClassScript, err, out)
	}
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatalf("reading rewritten file: %v", err)
	}
	return string(b)
}

func ingressClassOf(t *testing.T, raw string) string {
	t.Helper()
	var obj struct {
		Data map[string]string `yaml:"data"`
	}
	if err := yaml.Unmarshal([]byte(raw), &obj); err != nil {
		t.Fatalf("decoding rewritten yaml: %v", err)
	}
	return obj.Data["ingress-class"]
}
