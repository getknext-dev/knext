/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/yaml"
)

// isSameNamespaceMetricsRule identifies ADR-0044's co-resident Prometheus rule
// on NextApp: NamespaceSelector nil + empty PodSelector on {9090, 9464} only.
func isSameNamespaceMetricsRule(rule networkingv1.NetworkPolicyIngressRule) bool {
	if len(rule.From) != 1 {
		return false
	}
	p := rule.From[0]
	if p.NamespaceSelector != nil || p.PodSelector == nil || p.IPBlock != nil {
		return false
	}
	if len(p.PodSelector.MatchLabels) != 0 || len(p.PodSelector.MatchExpressions) != 0 {
		return false
	}
	got := extractStrictTCPPorts(nil, rule)
	return reflect.DeepEqual(got, []int32{9090, 9464})
}

// isOptInMetricsScrapeRule identifies #735's opt-in cross-namespace Prometheus
// rule on NextApp: knext.dev/metrics-scrape=true on port 9464 only.
func isOptInMetricsScrapeRule(rule networkingv1.NetworkPolicyIngressRule) bool {
	if len(rule.From) != 1 {
		return false
	}
	p := rule.From[0]
	if p.NamespaceSelector == nil || p.PodSelector != nil || p.IPBlock != nil {
		return false
	}
	if len(p.NamespaceSelector.MatchExpressions) != 0 || len(p.NamespaceSelector.MatchLabels) != 1 {
		return false
	}
	if p.NamespaceSelector.MatchLabels[metricsScrapeNamespaceLabel] != "true" {
		return false
	}
	got := extractStrictTCPPorts(nil, rule)
	return reflect.DeepEqual(got, []int32{9464})
}

func selectorIsEmpty(sel *metav1.LabelSelector) bool {
	return sel == nil || (len(sel.MatchLabels) == 0 && len(sel.MatchExpressions) == 0)
}

func selectsWholeNamespace(peer networkingv1.NetworkPolicyPeer) bool {
	return peer.NamespaceSelector != nil && selectorIsEmpty(peer.PodSelector)
}

func extractStrictTCPPorts(t *testing.T, rule networkingv1.NetworkPolicyIngressRule) []int32 {
	if len(rule.Ports) == 0 {
		if t != nil {
			t.Fatalf("ingress rule has empty Ports (admits ALL ports): %+v", rule)
		}
		return nil
	}
	var out []int32
	for _, p := range rule.Ports {
		if p.Port == nil || p.Port.Type != intstr.Int {
			if t != nil {
				t.Fatalf("ingress port must be numeric, got %+v", p)
			}
			return nil
		}
		if p.EndPort != nil {
			if t != nil {
				t.Fatalf("ingress port range (EndPort=%d) is forbidden", *p.EndPort)
			}
			return nil
		}
		if p.Protocol != nil && *p.Protocol != corev1.ProtocolTCP {
			if t != nil {
				t.Fatalf("unexpected protocol %q", *p.Protocol)
			}
			return nil
		}
		out = append(out, p.Port.IntVal)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// peerMatchesPod evaluates Kubernetes NetworkPolicyPeer semantics (AND between
// NamespaceSelector and PodSelector when both are on the same peer element).
func peerMatchesPod(
	t *testing.T,
	peer networkingv1.NetworkPolicyPeer,
	policyNamespace string,
	podNamespace string,
	podNamespaceLabels map[string]string,
	podLabels map[string]string,
) bool {
	t.Helper()
	if peer.IPBlock != nil {
		t.Fatalf("unexpected IPBlock peer in cluster-internal NetworkPolicy: %+v", peer.IPBlock)
	}
	if peer.NamespaceSelector == nil && peer.PodSelector == nil {
		t.Fatalf("invalid empty NetworkPolicyPeer (neither NamespaceSelector nor PodSelector set)")
	}

	if peer.NamespaceSelector != nil {
		nsSel, err := metav1.LabelSelectorAsSelector(peer.NamespaceSelector)
		if err != nil {
			t.Fatalf("invalid NamespaceSelector %+v: %v", peer.NamespaceSelector, err)
		}
		if !nsSel.Matches(labels.Set(podNamespaceLabels)) {
			return false
		}
	} else if podNamespace != policyNamespace {
		// Nil NamespaceSelector with non-nil PodSelector matches only the policy's own namespace.
		return false
	}

	if peer.PodSelector != nil {
		podSel, err := metav1.LabelSelectorAsSelector(peer.PodSelector)
		if err != nil {
			t.Fatalf("invalid PodSelector %+v: %v", peer.PodSelector, err)
		}
		if !podSel.Matches(labels.Set(podLabels)) {
			return false
		}
	}
	return true
}

// admittedPortsForPod returns the sorted deduplicated set of TCP ports admitted
// by `np` for a source pod, unioned across all matching ingress rules (Kubernetes
// NetworkPolicy rules are additive, and `From` elements within a rule are ORed).
func admittedPortsForPod(
	t *testing.T,
	np *networkingv1.NetworkPolicy,
	podNamespace string,
	podNamespaceLabels map[string]string,
	podLabels map[string]string,
) []int32 {
	t.Helper()
	portSet := map[int32]bool{}
	for _, rule := range np.Spec.Ingress {
		ports := extractStrictTCPPorts(t, rule)
		if len(rule.From) == 0 {
			t.Fatalf("ingress rule in %s has empty From (admits ALL sources)", np.Name)
		}
		matched := false
		for _, peer := range rule.From {
			if peerMatchesPod(t, peer, np.Namespace, podNamespace, podNamespaceLabels, podLabels) {
				matched = true
				break
			}
		}
		if matched {
			for _, p := range ports {
				portSet[p] = true
			}
		}
	}
	var out []int32
	for p := range portSet {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// 1. Shared helper + rendered rules: each Knative/Kourier peer has BOTH
// namespaceSelector and podSelector in ONE `from` element (AND semantics;
// splitting into two elements would OR and widen).
func TestNetworkPolicyPeersHaveNamespaceAndPodSelectorInOneElement(t *testing.T) {
	t.Run("podInNamespacePeer helper builds single ANDed element and rejects empty selectors", func(t *testing.T) {
		callerLabels := map[string]string{"app": "activator"}
		peer := podInNamespacePeer("knative-serving", callerLabels)
		if peer.IPBlock != nil {
			t.Fatalf("expected nil IPBlock, got %+v", peer.IPBlock)
		}
		if peer.NamespaceSelector == nil || peer.PodSelector == nil {
			t.Fatalf("expected both NamespaceSelector and PodSelector on single peer, got %+v", peer)
		}
		if got := peer.NamespaceSelector.MatchLabels; !reflect.DeepEqual(got, map[string]string{"kubernetes.io/metadata.name": "knative-serving"}) {
			t.Errorf("unexpected NamespaceSelector.MatchLabels: %v", got)
		}
		if got := peer.PodSelector.MatchLabels; !reflect.DeepEqual(got, map[string]string{"app": "activator"}) {
			t.Errorf("unexpected PodSelector.MatchLabels: %v", got)
		}
		// Mutating the caller's map after construction must not mutate the rendered peer.
		callerLabels["app"] = "mutated"
		if peer.PodSelector.MatchLabels["app"] != "activator" {
			t.Errorf("podInNamespacePeer aliased caller's map: got %v", peer.PodSelector.MatchLabels)
		}

		for _, bad := range []struct {
			name string
			fn   func()
		}{
			{"empty namespace", func() { podInNamespacePeer("", map[string]string{"app": "activator"}) }},
			{"nil podLabels", func() { podInNamespacePeer("knative-serving", nil) }},
			{"empty podLabels", func() { podInNamespacePeer("knative-serving", map[string]string{}) }},
			{"empty label key", func() { podInNamespacePeer("knative-serving", map[string]string{"": "activator"}) }},
			{"empty label value", func() { podInNamespacePeer("knative-serving", map[string]string{"app": ""}) }},
		} {
			func() {
				defer func() {
					if recover() == nil {
						t.Errorf("expected panic for %s", bad.name)
					}
				}()
				bad.fn()
			}()
		}
	})

	t.Run("NextApp default NetworkPolicy", func(t *testing.T) {
		np := DesiredNetworkPolicy("orders", "shop")
		checked := 0
		for i, rule := range np.Spec.Ingress {
			if isSameNamespaceMetricsRule(rule) || isOptInMetricsScrapeRule(rule) {
				continue
			}
			if len(rule.From) == 0 {
				t.Fatalf("rule[%d] has empty From", i)
			}
			for j, peer := range rule.From {
				checked++
				if selectorIsEmpty(peer.NamespaceSelector) || selectorIsEmpty(peer.PodSelector) {
					t.Errorf("NextApp rule[%d].from[%d] must combine non-empty namespaceSelector AND podSelector in one element, got %+v",
						i, j, peer)
				}
			}
		}
		if checked < 3 {
			t.Errorf("expected at least 3 narrowed Knative/Kourier peers (activator, kourier, autoscaler), inspected %d", checked)
		}
	})

	t.Run("BackendService function NetworkPolicy", func(t *testing.T) {
		np := DesiredFunctionNetworkPolicy("pricing", "orders", "shop")
		checked := 0
		for i, rule := range np.Spec.Ingress {
			if len(rule.From) == 0 {
				t.Fatalf("rule[%d] has empty From", i)
			}
			for j, peer := range rule.From {
				checked++
				if selectorIsEmpty(peer.NamespaceSelector) || selectorIsEmpty(peer.PodSelector) {
					t.Errorf("Function rule[%d].from[%d] must combine non-empty namespaceSelector AND podSelector in one element, got %+v",
						i, j, peer)
				}
			}
		}
		if checked < 3 {
			t.Errorf("expected at least 3 narrowed Knative/Kourier peers (activator, kourier, autoscaler), inspected %d", checked)
		}
	})
}

// 2. Autoscaler peer only on port 9090; activator on all queue-proxy serving
// ports incl 8112; Kourier gateway on serving ports; non-matching control-plane
// and cross-namespace spoofed pods admitted on NO ports.
func TestNetworkPolicyPeerPortMatrix(t *testing.T) {
	knativeNSLabels := map[string]string{"kubernetes.io/metadata.name": "knative-serving"}
	kourierNSLabels := map[string]string{"kubernetes.io/metadata.name": "kourier-system"}
	evilNSLabels := map[string]string{"kubernetes.io/metadata.name": "tenant-evil"}

	policies := []struct {
		name string
		np   *networkingv1.NetworkPolicy
	}{
		{"NextApp", DesiredNetworkPolicy("orders", "shop")},
		{"BackendService", DesiredFunctionNetworkPolicy("pricing", "orders", "shop")},
	}

	for _, tc := range policies {
		t.Run(tc.name, func(t *testing.T) {
			cases := []struct {
				desc      string
				podNS     string
				nsLabels  map[string]string
				podLabels map[string]string
				wantPorts []int32
			}{
				{
					desc:      "activator pod in knative-serving gets all queue-proxy serving ports incl 8112",
					podNS:     "knative-serving",
					nsLabels:  knativeNSLabels,
					podLabels: map[string]string{"app": "activator", "role": "activator"},
					wantPorts: []int32{8012, 8013, 8112},
				},
				{
					desc:      "autoscaler pod in knative-serving gets port 9090 only",
					podNS:     "knative-serving",
					nsLabels:  knativeNSLabels,
					podLabels: map[string]string{"app": "autoscaler"},
					wantPorts: []int32{9090},
				},
				{
					desc:      "Kourier gateway pod in kourier-system gets serving ports",
					podNS:     "kourier-system",
					nsLabels:  kourierNSLabels,
					podLabels: map[string]string{"app": "3scale-kourier-gateway"},
					wantPorts: []int32{8012, 8013, 8112},
				},
				{
					desc:      "Kourier gateway pod in knative-serving (Knative Operator layout) gets serving ports",
					podNS:     "knative-serving",
					nsLabels:  knativeNSLabels,
					podLabels: map[string]string{"app": "3scale-kourier-gateway"},
					wantPorts: []int32{8012, 8013, 8112},
				},
				{
					desc:      "Kourier gateway pod in knative-serving-ingress (OpenShift layout) gets serving ports",
					podNS:     "knative-serving-ingress",
					nsLabels:  map[string]string{"kubernetes.io/metadata.name": "knative-serving-ingress"},
					podLabels: map[string]string{"app": "3scale-kourier-gateway"},
					wantPorts: []int32{8012, 8013, 8112},
				},
				{
					desc:      "non-gateway pod in knative-serving-ingress is refused on all ports",
					podNS:     "knative-serving-ingress",
					nsLabels:  map[string]string{"kubernetes.io/metadata.name": "knative-serving-ingress"},
					podLabels: map[string]string{"app": "other"},
					wantPorts: nil,
				},
				{
					desc:      "knative-serving controller pod is refused on all ports",
					podNS:     "knative-serving",
					nsLabels:  knativeNSLabels,
					podLabels: map[string]string{"app": "controller"},
					wantPorts: nil,
				},
				{
					desc:      "knative-serving webhook pod is refused on all ports",
					podNS:     "knative-serving",
					nsLabels:  knativeNSLabels,
					podLabels: map[string]string{"app": "webhook"},
					wantPorts: nil,
				},
				{
					desc:      "knative-serving net-kourier-controller pod is refused on all ports",
					podNS:     "knative-serving",
					nsLabels:  knativeNSLabels,
					podLabels: map[string]string{"app": "net-kourier-controller"},
					wantPorts: nil,
				},
				{
					desc:      "non-gateway pod in kourier-system is refused on all ports",
					podNS:     "kourier-system",
					nsLabels:  kourierNSLabels,
					podLabels: map[string]string{"app": "other"},
					wantPorts: nil,
				},
				{
					desc:      "spoofed app=activator pod in another namespace is refused (AND semantics)",
					podNS:     "tenant-evil",
					nsLabels:  evilNSLabels,
					podLabels: map[string]string{"app": "activator"},
					wantPorts: nil,
				},
				{
					desc:      "spoofed app=autoscaler pod in another namespace is refused (AND semantics)",
					podNS:     "tenant-evil",
					nsLabels:  evilNSLabels,
					podLabels: map[string]string{"app": "autoscaler"},
					wantPorts: nil,
				},
				{
					desc:      "spoofed app=3scale-kourier-gateway pod in another namespace is refused (AND semantics)",
					podNS:     "tenant-evil",
					nsLabels:  evilNSLabels,
					podLabels: map[string]string{"app": "3scale-kourier-gateway"},
					wantPorts: nil,
				},
			}

			for _, c := range cases {
				got := admittedPortsForPod(t, tc.np, c.podNS, c.nsLabels, c.podLabels)
				if !reflect.DeepEqual(got, c.wantPorts) {
					t.Errorf("%s: got admitted ports %v, want %v", c.desc, got, c.wantPorts)
				}
			}
		})
	}
}

// 3. No Knative/Kourier peer selects a whole namespace (podSelector nil or empty
// `{}` is a failure).
func TestNetworkPolicyNoWholeNamespacePeers(t *testing.T) {
	// Self-check: both nil and empty `{}` PodSelector must trip selectsWholeNamespace.
	nsSel := &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": "knative-serving"}}
	if !selectsWholeNamespace(networkingv1.NetworkPolicyPeer{NamespaceSelector: nsSel, PodSelector: nil}) {
		t.Fatal("mutation control failed: nil PodSelector did not flag as whole-namespace")
	}
	if !selectsWholeNamespace(networkingv1.NetworkPolicyPeer{NamespaceSelector: nsSel, PodSelector: &metav1.LabelSelector{}}) {
		t.Fatal("mutation control failed: empty PodSelector{} did not flag as whole-namespace")
	}

	npApp := DesiredNetworkPolicy("orders", "shop")
	for i, rule := range npApp.Spec.Ingress {
		if isOptInMetricsScrapeRule(rule) {
			continue
		}
		for j, peer := range rule.From {
			if selectsWholeNamespace(peer) {
				t.Errorf("NextApp rule[%d].from[%d] selects a whole namespace (PodSelector nil or empty): %+v", i, j, peer)
			}
		}
	}

	npFn := DesiredFunctionNetworkPolicy("pricing", "orders", "shop")
	for i, rule := range npFn.Spec.Ingress {
		for j, peer := range rule.From {
			if selectsWholeNamespace(peer) {
				t.Errorf("Function rule[%d].from[%d] selects a whole namespace (PodSelector nil or empty): %+v", i, j, peer)
			}
		}
	}
}

// 4. Label-drift guard: pins the exact Knative Serving and Kourier namespace +
// pod-selector constants and verifies them against the upstream Knative deployment
// manifests in the Go module cache and the repo's pinned Kourier installer.
func TestNetworkPolicyPodLabelsPinnedAgainstUpstreamDrift(t *testing.T) {
	// Pin the package constants directly so renaming or changing any constant reds this test.
	const (
		wantKnativeNS          = "knative-serving"
		wantKourierNS          = "kourier-system"
		wantIngressNS          = "knative-serving-ingress"
		wantKnativeLabelKey    = "app"
		wantActivatorLabelVal  = "activator"
		wantAutoscalerLabelVal = "autoscaler"
		wantKourierLabelKey    = "app"
		wantKourierLabelVal    = "3scale-kourier-gateway"
	)
	for _, pin := range []struct {
		name, got, want string
	}{
		{"knativeServingNamespace", knativeServingNamespace, wantKnativeNS},
		{"kourierSystemNamespace", kourierSystemNamespace, wantKourierNS},
		{"knativeServingIngressNamespace", knativeServingIngressNamespace, wantIngressNS},
		{"knativePodLabelKey", knativePodLabelKey, wantKnativeLabelKey},
		{"activatorPodLabelValue", activatorPodLabelValue, wantActivatorLabelVal},
		{"autoscalerPodLabelValue", autoscalerPodLabelValue, wantAutoscalerLabelVal},
		{"kourierGatewayPodLabelKey", kourierGatewayPodLabelKey, wantKourierLabelKey},
		{"kourierGatewayPodLabelValue", kourierGatewayPodLabelValue, wantKourierLabelVal},
	} {
		if pin.got != pin.want {
			t.Errorf("pinned constant %s drifted: got %q, want %q", pin.name, pin.got, pin.want)
		}
	}

	// Resolve knative.dev/serving from the local Go module cache (offline).
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "knative.dev/serving").CombinedOutput()
	if err != nil {
		t.Fatalf("locate knative.dev/serving module dir: %v (%s)", err, string(out))
	}
	knativeModDir := strings.TrimSpace(string(out))

	readKnativeDeployment := func(file string) *appsv1.Deployment {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(knativeModDir, "config", "core", "deployments", file))
		if err != nil {
			t.Fatalf("read knative deployment %s: %v", file, err)
		}
		for _, doc := range strings.Split(string(raw), "\n---") {
			var head struct {
				Kind string `json:"kind"`
			}
			if err := yaml.Unmarshal([]byte(doc), &head); err != nil {
				t.Fatalf("parse %s header: %v", file, err)
			}
			if head.Kind != "Deployment" {
				continue
			}
			dep := &appsv1.Deployment{}
			if err := yaml.Unmarshal([]byte(doc), dep); err != nil {
				t.Fatalf("unmarshal Deployment in %s: %v", file, err)
			}
			return dep
		}
		t.Fatalf("no Deployment found in %s", file)
		return nil
	}

	activatorDep := readKnativeDeployment("activator.yaml")
	autoscalerDep := readKnativeDeployment("autoscaler.yaml")
	controllerDep := readKnativeDeployment("controller.yaml")
	webhookDep := readKnativeDeployment("webhook.yaml")

	if activatorDep.Namespace != "knative-serving" || activatorDep.Spec.Template.Labels["app"] != "activator" {
		t.Fatalf("upstream Knative activator pod identity drifted: ns=%q labels=%v",
			activatorDep.Namespace, activatorDep.Spec.Template.Labels)
	}
	if autoscalerDep.Namespace != "knative-serving" || autoscalerDep.Spec.Template.Labels["app"] != "autoscaler" {
		t.Fatalf("upstream Knative autoscaler pod identity drifted: ns=%q labels=%v",
			autoscalerDep.Namespace, autoscalerDep.Spec.Template.Labels)
	}
	if controllerDep.Spec.Template.Labels["app"] == "activator" || controllerDep.Spec.Template.Labels["app"] == "autoscaler" {
		t.Fatalf("upstream Knative controller pod shares activator/autoscaler app label: %v", controllerDep.Spec.Template.Labels)
	}
	if webhookDep.Spec.Template.Labels["app"] == "activator" || webhookDep.Spec.Template.Labels["app"] == "autoscaler" {
		t.Fatalf("upstream Knative webhook pod shares activator/autoscaler app label: %v", webhookDep.Spec.Template.Labels)
	}

	// Verify the repo's pinned Kourier installer still targets kourier-system / 3scale-kourier-gateway
	// at the pinned manifest checksum (if the Kourier manifest changes, re-verify the gateway pod label).
	repoRoot := filepath.Join("..", "..", "..", "..")
	prereqsScript, err := os.ReadFile(filepath.Join(repoRoot, "scripts", "prereqs", "install.sh"))
	if err != nil {
		t.Fatalf("read scripts/prereqs/install.sh: %v", err)
	}
	if !strings.Contains(string(prereqsScript), "-n kourier-system deployment/3scale-kourier-gateway") {
		t.Errorf("scripts/prereqs/install.sh no longer names '-n kourier-system deployment/3scale-kourier-gateway' — verify Kourier gateway namespace/labels")
	}
	kourierApplyScript, err := os.ReadFile(filepath.Join(repoRoot, "scripts", "kind-manifests", "apply-knative-kourier.sh"))
	if err != nil {
		t.Fatalf("read scripts/kind-manifests/apply-knative-kourier.sh: %v", err)
	}
	const pinnedKourierSHA256 = `KOURIER_SHA256="381efeb83e0f424d7ada19a581ecfa9a8267aae396d9100e836cc131cc7d210f"`
	if !strings.Contains(string(kourierApplyScript), pinnedKourierSHA256) {
		t.Errorf("apply-knative-kourier.sh KOURIER_SHA256 moved; verify spec.template.metadata.labels (app: 3scale-kourier-gateway in kourier-system) in the new kourier.yaml before updating pinnedKourierSHA256")
	}

	// Verify both rendered policies contain the exact three pinned (namespace, app=<label>) peers.
	wantPeers := map[string]bool{
		"ns=knative-serving,pod=app:activator":                      false,
		"ns=knative-serving,pod=app:autoscaler":                     false,
		"ns=kourier-system,pod=app:3scale-kourier-gateway":          false,
		"ns=knative-serving,pod=app:3scale-kourier-gateway":         false,
		"ns=knative-serving-ingress,pod=app:3scale-kourier-gateway": false,
	}
	for _, tc := range []struct {
		name string
		np   *networkingv1.NetworkPolicy
	}{
		{"NextApp", DesiredNetworkPolicy("orders", "shop")},
		{"BackendService", DesiredFunctionNetworkPolicy("pricing", "orders", "shop")},
	} {
		seen := map[string]bool{}
		for _, rule := range tc.np.Spec.Ingress {
			if isSameNamespaceMetricsRule(rule) || isOptInMetricsScrapeRule(rule) {
				continue
			}
			for _, peer := range rule.From {
				if peer.NamespaceSelector == nil || peer.PodSelector == nil {
					t.Errorf("%s has peer missing namespaceSelector or podSelector: %+v", tc.name, peer)
					continue
				}
				ns := peer.NamespaceSelector.MatchLabels["kubernetes.io/metadata.name"]
				app := peer.PodSelector.MatchLabels["app"]
				key := fmt.Sprintf("ns=%s,pod=app:%s", ns, app)
				if _, ok := wantPeers[key]; !ok || len(peer.NamespaceSelector.MatchLabels) != 1 || len(peer.PodSelector.MatchLabels) != 1 ||
					len(peer.NamespaceSelector.MatchExpressions) != 0 || len(peer.PodSelector.MatchExpressions) != 0 {
					t.Errorf("%s rendered unexpected peer selector %q (%+v)", tc.name, key, peer)
				}
				seen[key] = true
			}
		}
		for wantKey := range wantPeers {
			if !seen[wantKey] {
				t.Errorf("%s missing expected pinned peer %s", tc.name, wantKey)
			}
		}
	}
}
