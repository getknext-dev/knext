// Package install — high-availability (leader-election) manifest contract (issue #307).
//
// These are STRUCTURAL assertions on the rendered manager manifests: the operator
// runs 2 replicas behind leader election, so exactly one instance reconciles at a
// time (single-writer, ADR-0001) while a standby takes over on failure. The tests
// pin the three shapes the HA change must have and — critically — that the
// `--leader-elect` flag SURVIVES the replica bump. A replicas:2 Deployment WITHOUT
// leader election is the split-brain footgun (two active reconcilers), so that
// assertion is load-bearing, not cosmetic.
//
// Not covered here (deliberate scope line): actual lease-failover behavior. Proving a
// standby acquires the lease and resumes reconciliation on primary loss needs an
// envtest/e2e harness; that gap is noted in the PR, not smuggled into a unit test.
package install

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// managerDeployment decodes the Deployment document out of config/manager/manager.yaml
// (a multi-doc file that also carries the system Namespace).
func managerDeployment(t *testing.T) map[string]any {
	t.Helper()
	raw := repoFile(t, "config/manager/manager.yaml")
	dec := yaml.NewDecoder(strings.NewReader(raw))
	for {
		var doc map[string]any
		if err := dec.Decode(&doc); err != nil {
			break
		}
		if doc == nil {
			continue
		}
		if kind, _ := doc["kind"].(string); kind == "Deployment" {
			return doc
		}
	}
	t.Fatalf("config/manager/manager.yaml: no Deployment document found")
	return nil
}

// AC1: the manager Deployment runs 2 replicas (HA — a standby ready to take the lease).
func TestManagerDeploymentHasTwoReplicas(t *testing.T) {
	dep := managerDeployment(t)
	spec, _ := dep["spec"].(map[string]any)
	if spec == nil {
		t.Fatalf("Deployment.spec missing")
	}
	replicas, ok := spec["replicas"]
	if !ok {
		t.Fatalf("Deployment.spec.replicas missing (want 2)")
	}
	got, ok := replicas.(int)
	if !ok {
		t.Fatalf("Deployment.spec.replicas is %T, want int", replicas)
	}
	if got != 2 {
		t.Errorf("Deployment.spec.replicas = %d, want 2 (HA)", got)
	}
}

// AC (BINDING): --leader-elect must STILL be in the manager container args. A
// replicas:2 Deployment without this flag runs two active reconcilers (split-brain).
func TestManagerKeepsLeaderElectFlag(t *testing.T) {
	dep := managerDeployment(t)
	spec, _ := dep["spec"].(map[string]any)
	tmpl, _ := spec["template"].(map[string]any)
	pspec, _ := tmpl["spec"].(map[string]any)
	containers, _ := pspec["containers"].([]any)
	if len(containers) == 0 {
		t.Fatalf("Deployment: no containers found")
	}
	found := false
	for _, c := range containers {
		cm, _ := c.(map[string]any)
		name, _ := cm["name"].(string)
		if name != "manager" {
			continue
		}
		args, _ := cm["args"].([]any)
		for _, a := range args {
			if s, _ := a.(string); s == "--leader-elect" {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("manager container args missing --leader-elect: replicas:2 without leader election is split-brain")
	}
}

// managerContainer returns the `manager` container map from the Deployment.
func managerContainer(t *testing.T) map[string]any {
	t.Helper()
	dep := managerDeployment(t)
	spec, _ := dep["spec"].(map[string]any)
	tmpl, _ := spec["template"].(map[string]any)
	pspec, _ := tmpl["spec"].(map[string]any)
	containers, _ := pspec["containers"].([]any)
	for _, c := range containers {
		cm, _ := c.(map[string]any)
		if name, _ := cm["name"].(string); name == "manager" {
			return cm
		}
	}
	t.Fatalf("manager container not found in Deployment")
	return nil
}

// AC (limits): the manager must declare BOTH requests and limits for cpu and
// memory. Without limits an OOM/runaway operator can starve co-tenants and get
// evicted unpredictably — the exact failure #307 is about (a crashed/OOM-killed
// operator stalling reconciliation). Requests are what the scheduler and the
// PodDisruptionBudget rely on to keep a replica placeable.
func TestManagerHasResourceRequestsAndLimits(t *testing.T) {
	cm := managerContainer(t)
	res, _ := cm["resources"].(map[string]any)
	if res == nil {
		t.Fatalf("manager container has no resources block (want requests+limits for cpu+memory)")
	}
	for _, kind := range []string{"requests", "limits"} {
		q, _ := res[kind].(map[string]any)
		if q == nil {
			t.Fatalf("manager resources.%s missing", kind)
		}
		for _, dim := range []string{"cpu", "memory"} {
			if _, ok := q[dim]; !ok {
				t.Errorf("manager resources.%s.%s missing", kind, dim)
			}
		}
	}
}

// AC (probes): the manager must have BOTH a liveness and a readiness probe on
// the health-probe port, and they must be HTTP probes on /healthz and /readyz
// (the endpoints main.go registers). A replicas:2 HA deployment without probes
// can't detect a wedged replica or gate rollout on readiness.
func TestManagerHasLivenessAndReadinessProbes(t *testing.T) {
	cm := managerContainer(t)
	for _, p := range []struct{ key, path string }{
		{"livenessProbe", "/healthz"},
		{"readinessProbe", "/readyz"},
	} {
		probe, _ := cm[p.key].(map[string]any)
		if probe == nil {
			t.Errorf("manager container missing %s", p.key)
			continue
		}
		hg, _ := probe["httpGet"].(map[string]any)
		if hg == nil {
			t.Errorf("%s is not an httpGet probe", p.key)
			continue
		}
		if got, _ := hg["path"].(string); got != p.path {
			t.Errorf("%s httpGet.path = %q, want %q", p.key, got, p.path)
		}
	}
}

// AC (no :latest, CLAUDE.md §4): the kustomize image override must be
// digest-pinned (@sha256:) and never :latest — an operator that silently pulls
// a moving tag on restart defeats the whole HA story.
func TestManagerImageIsDigestPinnedNotLatest(t *testing.T) {
	k := repoFile(t, "config/manager/kustomization.yaml")
	if strings.Contains(k, ":latest") {
		t.Errorf("config/manager/kustomization.yaml pins a :latest image — must be @sha256: digest-pinned")
	}
	if !strings.Contains(k, "@sha256:") {
		t.Errorf("config/manager/kustomization.yaml image override is not digest-pinned (@sha256: missing)")
	}
}

// AC2: soft pod anti-affinity — preferredDuringSchedulingIgnoredDuringExecution.
// It MUST be soft: hard (requiredDuring...) anti-affinity would strand the 2nd
// replica Pending forever on single-node/kind/CI clusters.
func TestManagerHasSoftPodAntiAffinity(t *testing.T) {
	dep := managerDeployment(t)
	spec, _ := dep["spec"].(map[string]any)
	tmpl, _ := spec["template"].(map[string]any)
	pspec, _ := tmpl["spec"].(map[string]any)
	aff, _ := pspec["affinity"].(map[string]any)
	if aff == nil {
		t.Fatalf("Deployment pod spec has no affinity block (want soft podAntiAffinity)")
	}
	paa, _ := aff["podAntiAffinity"].(map[string]any)
	if paa == nil {
		t.Fatalf("affinity.podAntiAffinity missing")
	}
	if _, hard := paa["requiredDuringSchedulingIgnoredDuringExecution"]; hard {
		t.Errorf("podAntiAffinity uses requiredDuring... (hard) — would strand the 2nd replica Pending on single-node clusters; use preferredDuring...")
	}
	pref, ok := paa["preferredDuringSchedulingIgnoredDuringExecution"].([]any)
	if !ok || len(pref) == 0 {
		t.Fatalf("podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution missing/empty (want soft anti-affinity)")
	}
}

// AC3: a PodDisruptionBudget with minAvailable: 1 must exist and be wired into
// kustomize. minAvailable:2 / maxUnavailable:0 would block node drains and deadlock
// cluster maintenance with only 2 replicas, so the exact value is asserted.
func TestPodDisruptionBudgetMinAvailableOne(t *testing.T) {
	raw := repoFile(t, "config/manager/pdb.yaml")
	dec := yaml.NewDecoder(strings.NewReader(raw))
	var found bool
	for {
		var doc map[string]any
		if err := dec.Decode(&doc); err != nil {
			break
		}
		if doc == nil {
			continue
		}
		kind, _ := doc["kind"].(string)
		if kind != "PodDisruptionBudget" {
			continue
		}
		found = true
		spec, _ := doc["spec"].(map[string]any)
		if spec == nil {
			t.Fatalf("PodDisruptionBudget.spec missing")
		}
		if _, blocks := spec["maxUnavailable"]; blocks {
			t.Errorf("PDB sets maxUnavailable — with 2 replicas this can deadlock node drains; use minAvailable: 1")
		}
		ma, ok := spec["minAvailable"]
		if !ok {
			t.Fatalf("PDB.spec.minAvailable missing (want 1)")
		}
		if got, ok := ma.(int); !ok || got != 1 {
			t.Errorf("PDB.spec.minAvailable = %v, want 1", ma)
		}
		sel, _ := spec["selector"].(map[string]any)
		if sel == nil {
			t.Errorf("PDB.spec.selector missing — must target the controller-manager pods")
		}
	}
	if !found {
		t.Fatalf("config/manager/pdb.yaml: no PodDisruptionBudget document found")
	}
}

// AC (docs, issue #307 acceptance criterion): an HA section must exist and cover
// the load-bearing operator concepts — leader election, running 2 replicas, and
// the blast radius when the operator is down (running apps keep serving; only
// reconciliation pauses). Docs shipping with the change is a CLAUDE.md hard rule
// (2b); the acceptance criterion explicitly requires the HA section, so its
// existence + content is asserted here, not left to review.
func TestHighAvailabilityDocExists(t *testing.T) {
	doc := repoFile(t, "docs/high-availability.md")
	lower := strings.ToLower(doc)
	for _, want := range []string{
		"leader election",
		"2 replicas",
		"blast radius",
		"reconciliation",
	} {
		if !strings.Contains(lower, want) {
			t.Errorf("docs/high-availability.md does not mention %q", want)
		}
	}
	// The blast-radius promise: running apps keep serving while the operator is down.
	if !strings.Contains(lower, "keep serving") && !strings.Contains(lower, "keeps serving") {
		t.Errorf("docs/high-availability.md must state running apps keep serving when the operator is down")
	}
}

// TestPodDisruptionBudgetWiredIntoKustomize: pdb.yaml must be a kustomize resource,
// otherwise the PDB never renders into the install bundle.
func TestPodDisruptionBudgetWiredIntoKustomize(t *testing.T) {
	k := repoFile(t, "config/manager/kustomization.yaml")
	if !strings.Contains(k, "pdb.yaml") {
		t.Errorf("config/manager/kustomization.yaml does not include pdb.yaml as a resource")
	}
}
