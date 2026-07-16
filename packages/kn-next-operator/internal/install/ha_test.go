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
// envtest/e2e harness — that lives in
// internal/controller/leader_election_envtest_test.go (v6-P3), which starts two
// managers and asserts exactly one active leader plus deterministic hand-off. It is
// NOT smuggled into a unit test.
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

// TestPodDisruptionBudgetWiredIntoKustomize: pdb.yaml must be a kustomize resource,
// otherwise the PDB never renders into the install bundle.
func TestPodDisruptionBudgetWiredIntoKustomize(t *testing.T) {
	k := repoFile(t, "config/manager/kustomization.yaml")
	if !strings.Contains(k, "pdb.yaml") {
		t.Errorf("config/manager/kustomization.yaml does not include pdb.yaml as a resource")
	}
}
