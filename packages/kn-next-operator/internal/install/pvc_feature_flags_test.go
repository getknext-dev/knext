// Package install also verifies the operator-managed Knative PVC feature flags
// (issue #59): the install bundle ships a declarative `config-features` ConfigMap in
// the knative-serving namespace that enables BOTH the persistent-volume-claim and
// persistent-volume-write PodSpec feature flags. These are default-off in Knative
// Serving and gate the bytecode-cache ksvc (which mounts a WRITABLE PVC) — without
// them the admission webhook denies the ksvc and reconcile fails. Like config-network
// (#45), this ConfigMap is immune to the bundle's namespace transformer.
package install

import (
	"path/filepath"
	"strings"
	"testing"

	"os"

	"gopkg.in/yaml.v3"
)

const (
	wantConfigFeaturesName = "config-features"
	pvcClaimFlag           = "kubernetes.podspec-persistent-volume-claim"
	pvcWriteFlag           = "kubernetes.podspec-persistent-volume-write"
	wantFlagValue          = "enabled"
)

// TestConfigFeaturesManifestEnablesPVCFlags asserts the source manifest
// config/knative/config-features.yaml is a ConfigMap named config-features in the
// knative-serving namespace with both PVC feature flags enabled.
func TestConfigFeaturesManifestEnablesPVCFlags(t *testing.T) {
	raw := repoFile(t, "config/knative/config-features.yaml")

	var obj struct {
		Kind     string `yaml:"kind"`
		Metadata struct {
			Name      string `yaml:"name"`
			Namespace string `yaml:"namespace"`
		} `yaml:"metadata"`
		Data map[string]string `yaml:"data"`
	}
	if err := yaml.Unmarshal([]byte(raw), &obj); err != nil {
		t.Fatalf("decoding config-features.yaml: %v", err)
	}

	if obj.Kind != "ConfigMap" {
		t.Errorf("kind = %q, want ConfigMap", obj.Kind)
	}
	if obj.Metadata.Name != wantConfigFeaturesName {
		t.Errorf("metadata.name = %q, want %q", obj.Metadata.Name, wantConfigFeaturesName)
	}
	if obj.Metadata.Namespace != wantKnativeNamespace {
		t.Errorf("metadata.namespace = %q, want %q", obj.Metadata.Namespace, wantKnativeNamespace)
	}
	if got := obj.Data[pvcClaimFlag]; got != wantFlagValue {
		t.Errorf("data[%s] = %q, want %q", pvcClaimFlag, got, wantFlagValue)
	}
	if got := obj.Data[pvcWriteFlag]; got != wantFlagValue {
		t.Errorf("data[%s] = %q, want %q", pvcWriteFlag, got, wantFlagValue)
	}
}

// TestInstallBundleEnablesPVCFlags proves the kustomize wiring + namespace immunity:
// the rendered dist/install.yaml must contain the config-features ConfigMap STILL in
// knative-serving (not rewritten to the operator namespace by the top-level namespace
// transformer) with both PVC feature flags enabled. Skip cleanly when the bundle has
// not been generated (run `make build-installer`).
func TestInstallBundleEnablesPVCFlags(t *testing.T) {
	if _, err := os.Stat(filepath.Join("..", "..", "dist", "install.yaml")); err != nil {
		t.Skip("dist/install.yaml not generated (run `make build-installer`)")
	}
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
		if meta == nil || meta["name"] != wantConfigFeaturesName {
			continue
		}
		found = true
		if meta["namespace"] != wantKnativeNamespace {
			t.Errorf("config-features namespace = %v, want %q (namespace transformer must not rewrite it)",
				meta["namespace"], wantKnativeNamespace)
		}
		data, _ := obj["data"].(map[string]any)
		if data == nil || data[pvcClaimFlag] != wantFlagValue {
			t.Errorf("config-features data[%s] = %v, want %q", pvcClaimFlag, data[pvcClaimFlag], wantFlagValue)
		}
		if data == nil || data[pvcWriteFlag] != wantFlagValue {
			t.Errorf("config-features data[%s] = %v, want %q", pvcWriteFlag, data[pvcWriteFlag], wantFlagValue)
		}
	}
	if !found {
		t.Fatalf("dist/install.yaml: config-features ConfigMap not found in rendered bundle")
	}
}
