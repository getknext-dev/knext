// Package install also verifies the operator-managed Kourier ingress-class config
// (issue #45): the install bundle ships a declarative `config-network` ConfigMap in
// the knative-serving namespace that sets the ingress-class to the full Kourier form
// (kourier.ingress.networking.knative.dev), codifying the previously-manual
// `kubectl patch` and immune to the bundle's namespace transformer.
package install

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const (
	wantConfigNetworkName = "config-network"
	wantKnativeNamespace  = "knative-serving"
	wantIngressClass      = "kourier.ingress.networking.knative.dev"
)

// TestConfigNetworkManifestSetsKourierIngressClass asserts the source manifest
// config/knative/config-network.yaml is a ConfigMap named config-network in the
// knative-serving namespace with the full Kourier ingress-class.
func TestConfigNetworkManifestSetsKourierIngressClass(t *testing.T) {
	raw := repoFile(t, "config/knative/config-network.yaml")

	var obj struct {
		Kind     string `yaml:"kind"`
		Metadata struct {
			Name      string `yaml:"name"`
			Namespace string `yaml:"namespace"`
		} `yaml:"metadata"`
		Data map[string]string `yaml:"data"`
	}
	if err := yaml.Unmarshal([]byte(raw), &obj); err != nil {
		t.Fatalf("decoding config-network.yaml: %v", err)
	}

	if obj.Kind != "ConfigMap" {
		t.Errorf("kind = %q, want ConfigMap", obj.Kind)
	}
	if obj.Metadata.Name != wantConfigNetworkName {
		t.Errorf("metadata.name = %q, want %q", obj.Metadata.Name, wantConfigNetworkName)
	}
	if obj.Metadata.Namespace != wantKnativeNamespace {
		t.Errorf("metadata.namespace = %q, want %q", obj.Metadata.Namespace, wantKnativeNamespace)
	}
	if got := obj.Data["ingress-class"]; got != wantIngressClass {
		t.Errorf("data[ingress-class] = %q, want %q", got, wantIngressClass)
	}
}

// TestInstallBundleCarriesKourierIngressClass proves the kustomize wiring +
// namespace immunity: the rendered dist/install.yaml must contain the config-network
// ConfigMap STILL in knative-serving (not rewritten to the operator namespace by the
// top-level namespace transformer) with the kourier ingress-class. Skip cleanly when
// the bundle has not been generated (run `make build-installer`).
func TestInstallBundleCarriesKourierIngressClass(t *testing.T) {
	requireBundle(t)
	raw := repoFile(t, "dist/install.yaml")
	dec := yaml.NewDecoder(strings.NewReader(raw))

	found := false
	for {
		var obj map[string]any
		if err := dec.Decode(&obj); err != nil {
			break
		}
		if len(obj) == 0 {
			continue
		}
		if obj["kind"] != "ConfigMap" {
			continue
		}
		meta, _ := obj["metadata"].(map[string]any)
		if meta == nil || meta["name"] != wantConfigNetworkName {
			continue
		}
		found = true
		if meta["namespace"] != wantKnativeNamespace {
			t.Errorf("config-network namespace = %v, want %q (namespace transformer must not rewrite it)",
				meta["namespace"], wantKnativeNamespace)
		}
		data, _ := obj["data"].(map[string]any)
		if data == nil || data["ingress-class"] != wantIngressClass {
			t.Errorf("config-network data[ingress-class] = %v, want %q", data["ingress-class"], wantIngressClass)
		}
	}
	if !found {
		t.Fatalf("dist/install.yaml: config-network ConfigMap not found in rendered bundle")
	}
}
