package install

import (
	"bufio"
	"bytes"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/yaml"
)

// The platform layer's install contract (ADR-0064 D3): the bundle ships the
// KnextPlatform CRD and the role that manages it, but NEVER a KnextPlatform
// OBJECT. Upgrading the operator therefore changes nothing for anyone: an object
// in the bundle would be applied on every upgrade and would silently change the
// defaults of every app in the cluster. New users opt in with a separate apply.

type manifestDoc struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name string `json:"name"`
	} `json:"metadata"`
}

func decodeDocs(t *testing.T, raw []byte, source string) []manifestDoc {
	t.Helper()
	var out []manifestDoc
	dec := utilyaml.NewYAMLReader(bufio.NewReader(bytes.NewReader(raw)))
	for {
		doc, err := dec.Read()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("split %s: %v", source, err)
		}
		// Kustomize patch files are JSON-patch ARRAYS, not Kubernetes objects; they
		// carry no kind and cannot be a KnextPlatform, so they are skipped by name
		// rather than by swallowing a decode error.
		var generic interface{}
		if err := yaml.Unmarshal(doc, &generic); err != nil {
			t.Fatalf("unmarshal %s: %v", source, err)
		}
		if _, isMap := generic.(map[string]interface{}); !isMap {
			continue
		}
		var m manifestDoc
		if err := yaml.Unmarshal(doc, &m); err != nil {
			t.Fatalf("unmarshal %s as a manifest: %v", source, err)
		}
		if m.Kind != "" {
			out = append(out, m)
		}
	}
}

func isPlatformObject(m manifestDoc) bool {
	return m.Kind == "KnextPlatform" && strings.HasPrefix(m.APIVersion, "platform.kn-next.dev/")
}

// TestNoManifestUnderConfigIsAKnextPlatformObject scans EVERY manifest in config/
// (not an enumerated list, so a file added anywhere is seen). The only
// KnextPlatform in the tree is the CRD that defines the kind.
func TestNoManifestUnderConfigIsAKnextPlatformObject(t *testing.T) {
	root := filepath.Join("..", "..", "config")
	scanned, crdSeen := 0, false
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".yaml") {
			return nil
		}
		raw, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		scanned++
		for _, m := range decodeDocs(t, raw, path) {
			if isPlatformObject(m) {
				t.Errorf("%s contains a KnextPlatform OBJECT (%q). The bundle must ship the CRD but no object: "+
					"an object would be applied on every operator upgrade and change the defaults of every app", path, m.Metadata.Name)
			}
			if m.Kind == "CustomResourceDefinition" && m.Metadata.Name == "knextplatforms.platform.kn-next.dev" {
				crdSeen = true
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Both halves: a scan that found nothing, or never saw the CRD, proves nothing.
	if scanned < 20 {
		t.Fatalf("scanned only %d manifests under config/; the walk is broken", scanned)
	}
	if !crdSeen {
		t.Fatal("the KnextPlatform CRD is not under config/ — the scan would pass vacuously")
	}
}

// TestRenderedBundleShipsThePlatformCRDAndRoleButNoObject checks the rendered
// bundle itself (dist/install.yaml, built by `make build-installer`).
func TestRenderedBundleShipsThePlatformCRDAndRoleButNoObject(t *testing.T) {
	raw, err := os.ReadFile(requireBundle(t))
	if err != nil {
		t.Fatal(err)
	}
	var crd, role bool
	for _, m := range decodeDocs(t, raw, "dist/install.yaml") {
		switch {
		case isPlatformObject(m):
			t.Errorf("the rendered bundle contains a KnextPlatform object %q", m.Metadata.Name)
		case m.Kind == "CustomResourceDefinition" && m.Metadata.Name == "knextplatforms.platform.kn-next.dev":
			crd = true
		case m.Kind == "ClusterRole" && strings.HasSuffix(m.Metadata.Name, "knextplatform-admin-role"):
			role = true
		}
	}
	if !crd {
		t.Error("the rendered bundle does not ship the KnextPlatform CRD")
	}
	if !role {
		t.Error("the rendered bundle does not ship the knextplatform-admin ClusterRole")
	}
}
