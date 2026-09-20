package pswatcher

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	k8syaml "k8s.io/apimachinery/pkg/util/yaml"
)

// [T3 #1097] The pageserver-failover compute bounce must target the STABLE plane
// label plane=compute that every compute carries, NOT the per-app name app=compute
// (which misses operator-rendered per-app writers/RO that are labelled
// app=compute-<app>). This guard proves, in ONE place, that the selector and the
// labels AGREE:
//   1. the pswatcher Deployment env PSW_COMPUTE_SELECTOR == plane=compute
//   2. the cmd/pswatcher default for PSW_COMPUTE_SELECTOR == plane=compute
//   3. every compute Deployment manifest stamps plane: compute on its pod template
//   4. the WRITER-only consumers narrow that to plane=compute,role!=ro, and only
//      the read pools carry role: ro
//
// Mutation-prove: revert any of these to app=compute, drop a plane label from a
// pod template, or move role: ro onto a writer → red.

const (
	wantSelector       = "plane=compute"
	wantWriterSelector = "plane=compute,role!=ro"
	deployDir          = "../../../deploy"
)

func TestPSWComputeSelectorIsPlaneLabel(t *testing.T) {
	// (1) the shipped pswatcher manifest env value.
	psw := readFile(t, deployDir+"/58-pswatcher.yaml")
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

// Every compute Deployment the plane ships must carry plane: compute on its POD
// TEMPLATE so the failover bounce (which lists PODS by plane=compute) reaches it.
//
// SCAN, do not enumerate: the compute set is DERIVED from deploy/*.yaml by parsing
// each document and keeping the ones whose pod template runs a container named
// `compute`. A fifth compute manifest added later is therefore guarded the day it
// lands — enumerating paths is exactly how #1097 (a compute nobody bounced) happens.
//
// Parsing, not grepping, is also load-bearing: the manifests carry YAML COMMENTS
// containing the literal `plane: compute`, so a whole-file regex is satisfied by
// prose and stays green when the real labels are deleted. The parser sees labels
// only. The per-app render path (RenderDeployment/RenderRODeployment) is guarded
// separately in internal/appdb.
func TestAllComputeManifestsCarryPlaneLabel(t *testing.T) {
	computes := scanComputeManifests(t)
	for _, c := range computes {
		if c.templateLabels["plane"] != wantPlane {
			t.Errorf("%s (%s): pod template labels have plane=%q, want %q — this compute's PODS would not be bounced by the plane=compute failover selector",
				c.file, c.name, c.templateLabels["plane"], wantPlane)
		}
		if c.objectLabels["plane"] != wantPlane {
			t.Errorf("%s (%s): Deployment object labels have plane=%q, want %q — the drills select computes at the Deployment level with plane=compute",
				c.file, c.name, c.objectLabels["plane"], wantPlane)
		}
	}
}

// The WRITER-only consumers — the backup/WAL janitor's slot floor (deploy/62), the
// replication-slot monitor (deploy/63) and the writer autoscaler (deploy/85) —
// narrow the now-universal plane=compute to plane=compute,role!=ro. That narrowing
// is data-loss sensitive in BOTH directions, so it is guarded in both:
//
//   - if a writer-only selector loses the role!=ro clause it starts treating RO
//     replicas as publishers;
//   - if a WRITER ever gains role: ro it silently drops OUT of the slot floor and
//     the slot monitor — its WAL/slot protection goes blind with everything still
//     green.
//
// Reader-ness is derived from the compute's NAME (compute-ro…), never from the role
// label, so the guard cannot be satisfied by relabelling the thing it checks.
func TestWriterOnlyConsumersExcludeReadersByRoleLabel(t *testing.T) {
	// (1) the shipped writer-only pod selectors.
	podSelRe := regexp.MustCompile(`kubectl get pods -l ([^\s]+)`)
	for _, f := range []string{"/62-backup.yaml", "/63-repl-slot-monitor.yaml"} {
		body := readFile(t, deployDir+f)
		found := 0
		for _, m := range podSelRe.FindAllStringSubmatch(body, -1) {
			if !strings.Contains(m[1], "plane=") {
				continue // an unrelated pod selector (e.g. tier=apps)
			}
			found++
			if m[1] != wantWriterSelector {
				t.Errorf("deploy%s: compute-plane pod selector = %q, want %q — this consumer is WRITER-only; without role!=ro it treats RO replicas as publishers", f, m[1], wantWriterSelector)
			}
		}
		if found == 0 {
			t.Errorf("deploy%s: no `kubectl get pods -l plane=…` selector found — this consumer must select the writer computes as %q", f, wantWriterSelector)
		}
	}

	// (2) the writer autoscaler: manifest env + code default.
	was := readFile(t, deployDir+"/85-writer-autoscaler.yaml")
	wasRe := regexp.MustCompile(`(?m)WAS_SELECTOR,\s*value:\s*"([^"]+)"`)
	wm := wasRe.FindStringSubmatch(was)
	if wm == nil {
		t.Fatal("85-writer-autoscaler.yaml: could not find WAS_SELECTOR env value")
	}
	if wm[1] != wantWriterSelector {
		t.Errorf("85-writer-autoscaler.yaml WAS_SELECTOR = %q, want %q", wm[1], wantWriterSelector)
	}
	wasMain := readFile(t, "../../cmd/writer-autoscaler/main.go")
	wasDefRe := regexp.MustCompile(`env\("WAS_SELECTOR",\s*"([^"]+)"\)`)
	wdm := wasDefRe.FindStringSubmatch(wasMain)
	if wdm == nil {
		t.Fatal("cmd/writer-autoscaler/main.go: could not find WAS_SELECTOR default")
	}
	if wdm[1] != wantWriterSelector {
		t.Errorf("cmd/writer-autoscaler/main.go WAS_SELECTOR default = %q, want %q", wdm[1], wantWriterSelector)
	}

	// (3) role: ro belongs to the read pools and to NOTHING else.
	readers, writers := 0, 0
	for _, c := range scanComputeManifests(t) {
		reader := isReadPoolName(c.name)
		if reader {
			readers++
		} else {
			writers++
		}
		for what, labels := range map[string]map[string]string{
			"pod template": c.templateLabels,
			"object":       c.objectLabels,
		} {
			role := labels["role"]
			switch {
			case reader && role != "ro":
				t.Errorf("%s (%s): %s role=%q, want ro — a read replica without role: ro is picked up by the WRITER-only consumers (backup slot floor, repl-slot monitor, writer autoscaler)",
					c.file, c.name, what, role)
			case !reader && role == "ro":
				t.Errorf("%s (%s): %s carries role: ro but this is a WRITER — it would silently drop out of the backup slot floor and the replication-slot monitor, leaving its WAL and its slots unprotected",
					c.file, c.name, what)
			}
		}
	}
	if readers == 0 || writers < 2 {
		t.Fatalf("scanned %d read pools and %d writers, want >=1 and >=2 — the scan is broken, so the role checks above are vacuous", readers, writers)
	}
}

const wantPlane = "compute"

// isReadPoolName classifies a compute from its NAME, independently of the role
// label the guard is checking: the read pools are `compute-ro` (base) and
// `compute-ro-<app>` (per-app).
func isReadPoolName(name string) bool {
	return name == "compute-ro" || strings.HasPrefix(name, "compute-ro-")
}

type computeManifest struct {
	file           string
	name           string
	objectLabels   map[string]string
	templateLabels map[string]string
}

// scanComputeManifests parses every deploy/*.yaml document and returns the ones
// whose pod template runs a container named `compute` — the computes that attach
// to the pageserver and so must be bounced on failover. A parse error is a
// FAILURE, never a skip: a manifest this guard cannot read is a manifest it does
// not protect.
func scanComputeManifests(t *testing.T) []computeManifest {
	t.Helper()
	files, err := filepath.Glob(deployDir + "/*.yaml")
	if err != nil {
		t.Fatalf("glob %s: %v", deployDir, err)
	}
	if len(files) == 0 {
		t.Fatalf("no manifests found in %s", deployDir)
	}
	var out []computeManifest
	for _, f := range files {
		fh, err := os.Open(f) //nolint:gosec // test-only, path from a fixed glob
		if err != nil {
			t.Fatalf("open %s: %v", f, err)
		}
		dec := k8syaml.NewYAMLOrJSONDecoder(fh, 4096)
		for {
			var doc map[string]any
			err := dec.Decode(&doc)
			if err == io.EOF {
				break
			}
			if err != nil {
				fh.Close()
				t.Fatalf("parse %s: %v (a manifest this guard cannot parse is a manifest it does not protect)", f, err)
			}
			if doc == nil || !runsComputeContainer(doc) {
				continue
			}
			out = append(out, computeManifest{
				file:           filepath.Base(f),
				name:           str(dig(doc, "metadata", "name")),
				objectLabels:   stringMap(dig(doc, "metadata", "labels")),
				templateLabels: stringMap(dig(doc, "spec", "template", "metadata", "labels")),
			})
		}
		fh.Close()
	}
	// The plane ships at least four: base writer, warm writer, base RO pool and the
	// per-app template. Fewer means the scan broke and every assertion built on it
	// would pass vacuously.
	if len(out) < 4 {
		t.Fatalf("scanned %s and found %d compute manifests (%v), want >= 4 — the scan itself is broken, so the label guards would pass vacuously", deployDir, len(out), names(out))
	}
	return out
}

func runsComputeContainer(doc map[string]any) bool {
	containers, ok := dig(doc, "spec", "template", "spec", "containers").([]any)
	if !ok {
		return false
	}
	for _, c := range containers {
		cm, ok := c.(map[string]any)
		if ok && str(cm["name"]) == "compute" {
			return true
		}
	}
	return false
}

func names(cs []computeManifest) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.file+":"+c.name)
	}
	return out
}

func dig(doc map[string]any, path ...string) any {
	var cur any = doc
	for _, k := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[k]
	}
	return cur
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func stringMap(v any) map[string]string {
	m, ok := v.(map[string]any)
	if !ok {
		return map[string]string{}
	}
	out := make(map[string]string, len(m))
	for k, val := range m {
		out[k] = str(val)
	}
	return out
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path) //nolint:gosec // test-only, fixed repo-relative paths
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
