package pswatcher

import (
	"os"
	"regexp"
	"testing"
)

// [T3 #1097] The pageserver-failover compute bounce must target the STABLE plane
// label plane=compute that every compute carries, NOT the per-app name app=compute
// (which misses operator-rendered per-app writers/RO that are labelled
// app=compute-<app>). This guard proves, in ONE place, that the selector and the
// labels AGREE:
//   1. the pswatcher Deployment env PSW_COMPUTE_SELECTOR == plane=compute
//   2. the cmd/pswatcher default for PSW_COMPUTE_SELECTOR == plane=compute
//   3. every compute Deployment manifest stamps plane: compute on its pod template
// Mutation-prove: revert any of these to app=compute (or drop a plane label) → red.

const wantSelector = "plane=compute"

func TestPSWComputeSelectorIsPlaneLabel(t *testing.T) {
	// (1) the shipped pswatcher manifest env value.
	psw := readFile(t, "../../../deploy/58-pswatcher.yaml")
	selRe := regexp.MustCompile(`(?m)PSW_COMPUTE_SELECTOR,\s*value:\s*"([^"]+)"`)
	m := selRe.FindStringSubmatch(psw)
	if m == nil {
		t.Fatal("58-pswatcher.yaml: could not find PSW_COMPUTE_SELECTOR env value")
	}
	if m[1] != wantSelector {
		t.Errorf("58-pswatcher.yaml PSW_COMPUTE_SELECTOR = %q, want %q — the bounce must target every compute via the stable plane label, not the per-app name", m[1], wantSelector)
	}

	// (2) the code default in cmd/pswatcher/main.go.
	main := readFile(t, "../../cmd/pswatcher/main.go")
	defRe := regexp.MustCompile(`env\("PSW_COMPUTE_SELECTOR",\s*"([^"]+)"\)`)
	dm := defRe.FindStringSubmatch(main)
	if dm == nil {
		t.Fatal("cmd/pswatcher/main.go: could not find PSW_COMPUTE_SELECTOR default")
	}
	if dm[1] != wantSelector {
		t.Errorf("cmd/pswatcher/main.go PSW_COMPUTE_SELECTOR default = %q, want %q", dm[1], wantSelector)
	}
}

// Every compute Deployment manifest the plane ships must carry plane: compute on
// its POD TEMPLATE so the failover bounce (plane=compute) reaches it. Scan, do not
// enumerate assertions: a compute manifest whose template lacks the plane label
// FAILS here. The per-app render path (RenderDeployment/RenderRODeployment) is
// guarded separately in internal/appdb.
func TestAllComputeManifestsCarryPlaneLabel(t *testing.T) {
	// The four compute Deployments: base writer, warm writer, base RO pool, and the
	// per-app template. Each is a compute that attaches to the pageserver and so
	// must be bounced on failover.
	manifests := []string{
		"../../../deploy/20-compute.yaml",
		"../../../deploy/25-compute-warm.yaml",
		"../../../deploy/26-compute-ro.yaml",
		"../../../deploy/compute-app.template.yaml",
	}
	// Pod-template label blocks look like `labels: { app: compute-..., plane: compute }`.
	// Require plane: compute to appear in the template metadata of each.
	planeRe := regexp.MustCompile(`plane:\s*compute`)
	for _, f := range manifests {
		body := readFile(t, f)
		if !planeRe.MatchString(body) {
			t.Errorf("%s: no `plane: compute` label found — this compute would not be bounced by the plane=compute failover selector", f)
		}
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
