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
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

var _ = Describe("NextApp NetworkPolicy reconciliation", func() {
	ctx := context.Background()

	// reconcileApp creates the NextApp with the given security spec, reconciles
	// it once, and returns the namespaced name. Cleanup is registered via
	// DeferCleanup so the external-cleanup finalizer is driven correctly.
	reconcileApp := func(name string, security *appsv1alpha1.SecuritySpec) types.NamespacedName {
		nn := types.NamespacedName{Name: name, Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
				Security: security,
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		DeferCleanup(func() {
			deleteAndFinalize(ctx, nn)
		})

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		return nn
	}

	policyName := func(app string) types.NamespacedName {
		return types.NamespacedName{Name: app + "-allow-ingress", Namespace: "default"}
	}

	It("creates an owner-referenced in-cluster-only NetworkPolicy by default (Security nil)", func() {
		nn := reconcileApp("np-default", nil)

		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, policyName(nn.Name), np)).To(Succeed())

		By("targeting the app's Knative serving pods via podSelector")
		Expect(np.Spec.PodSelector.MatchLabels).To(HaveKeyWithValue("serving.knative.dev/service", nn.Name))

		By("declaring an Ingress policy type")
		Expect(np.Spec.PolicyTypes).To(ContainElement(networkingv1.PolicyTypeIngress))

		By("restricting ingress to in-cluster pod-scoped sources (activator + Kourier gateway + autoscaler + same namespace)")
		// FOUR rules (#2494 + ADR-0044 + #735):
		//   [0] serving ports (8012/8013/8112) from Knative activator + Kourier gateway pods
		//   [1] queue-proxy metrics port (9090) from Knative autoscaler pods only
		//   [2] metrics ports (9090/9464) from the same namespace
		//   [3] app metrics port (9464) from a namespace LABELLED for scraping (#735)
		Expect(np.Spec.Ingress).To(HaveLen(4))
		var froms []networkingv1.NetworkPolicyPeer
		for _, rule := range np.Spec.Ingress {
			froms = append(froms, rule.From...)
		}
		Expect(froms).NotTo(BeEmpty())

		var nsLabels []string
		var podAppLabels []string
		sameNamespace := false
		for _, peer := range froms {
			if peer.NamespaceSelector != nil {
				for _, v := range peer.NamespaceSelector.MatchLabels {
					nsLabels = append(nsLabels, v)
				}
				if _, isScrape := peer.NamespaceSelector.MatchLabels[metricsScrapeNamespaceLabel]; !isScrape {
					Expect(peer.PodSelector).NotTo(BeNil(), "Knative/Kourier peers must combine namespaceSelector and podSelector in one element")
					Expect(peer.PodSelector.MatchLabels).NotTo(BeEmpty(), "whole-namespace peers are forbidden (#2494)")
					podAppLabels = append(podAppLabels, peer.PodSelector.MatchLabels["app"])
				}
			}
			// A from-peer with neither selector populated would mean "all sources"
			// in the same namespace; an empty PodSelector with nil NamespaceSelector
			// means same-namespace-only.
			if peer.NamespaceSelector == nil && peer.PodSelector != nil {
				sameNamespace = true
			}
		}
		Expect(nsLabels).To(ContainElement("knative-serving"))
		Expect(nsLabels).To(ContainElement("kourier-system"))
		Expect(podAppLabels).To(ConsistOf("activator", "3scale-kourier-gateway", "3scale-kourier-gateway", "3scale-kourier-gateway", "autoscaler"))
		Expect(sameNamespace).To(BeTrue(), "expected a same-namespace ingress peer")

		By("owner-referencing the NextApp so it is GC'd on delete")
		Expect(np.OwnerReferences).To(HaveLen(1))
		Expect(np.OwnerReferences[0].Kind).To(Equal("NextApp"))
		Expect(np.OwnerReferences[0].Name).To(Equal(nn.Name))
	})

	It("restricts ingress PORTS so co-resident pods cannot bypass the queue-proxy (ADR-0044)", func() {
		// The rule used to carry NO Ports, which admits every port — so any
		// same-namespace pod could dial the app container's :3000 directly,
		// skipping queue-proxy and its containerConcurrency bound entirely
		// (the architect gate proved this in ADR-0044 round 1). The allowlist:
		//   8012/8013  queue-proxy serving (http1/h2c) — the ONLY way to the app
		//   9090       queue-proxy's own metrics
		//   9464       the app's metrics listener (the observability-annotations
		//              block in nextapp_controller.go stamps prometheus.io/port
		//              with the same number — a queue-proxy-only rule would
		//              kill scraping; both halves asserted here)
		// :3000 (the user port) is deliberately ABSENT: queue-proxy reaches it
		// over pod-local loopback (127.0.0.1:USER_PORT), which no NetworkPolicy
		// touches, so excluding it breaks nothing legitimate.
		nn := reconcileApp("np-ports", nil)

		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, policyName(nn.Name), np)).To(Succeed())
		Expect(np.Spec.Ingress).To(HaveLen(4))

		extractPorts := func(ports []networkingv1.NetworkPolicyPort) []int32 {
			Expect(ports).NotTo(BeEmpty(), "no Ports means ALL ports — the ADR-0044 bypass")
			var out []int32
			for _, p := range ports {
				Expect(p.Port).NotTo(BeNil())
				Expect(p.Port.Type).To(Equal(intstr.Int), "named ports would silently not match")
				// EndPort turns an entry into a RANGE: {Port: 8012, EndPort: 65535}
				// satisfies every other assertion here while reopening all high ports.
				Expect(p.EndPort).To(BeNil(), "a port RANGE reopens what the allowlist closes")
				out = append(out, p.Port.IntVal)
			}
			return out
		}

		servingPorts := extractPorts(np.Spec.Ingress[0].Ports)
		autoscalerPorts := extractPorts(np.Spec.Ingress[1].Ports)
		sameNsPorts := extractPorts(np.Spec.Ingress[2].Ports)
		scrapePorts := extractPorts(np.Spec.Ingress[3].Ports)

		By("admitting the queue-proxy serving ports on the activator/Kourier rule — the only sanctioned path to the app")
		// 8112 (BackendHTTPSPort) is appended to EVERY knative revision pod
		// unconditionally (v0.48 queue.go) and the activator dials it under
		// system-internal-tls. Omitting it is an OUTAGE, not a hardening — code
		// review caught its absence here.
		Expect(servingPorts).To(ConsistOf(int32(8012), int32(8013), int32(8112)))
		By("limiting the autoscaler rule strictly to queue-proxy metrics port 9090 (#2494)")
		Expect(autoscalerPorts).To(ConsistOf(int32(9090)))
		By("still admitting BOTH metrics ports on the same-namespace rule — a queue-proxy-only rule kills scraping")
		Expect(sameNsPorts).To(ConsistOf(int32(9090), int32(9464)))
		Expect(scrapePorts).To(ConsistOf(int32(9464)))
		By("refusing the app's user port across every rule — the direct-dial bypass this exists to close")
		for _, rulePorts := range [][]int32{servingPorts, autoscalerPorts, sameNsPorts, scrapePorts} {
			Expect(rulePorts).NotTo(ContainElement(int32(3000)))
		}
	})

	It("scopes the same-namespace peer to METRICS ports — closing the SCS synchronous-call leak (ADR-0044)", func() {
		// The other half of ADR-0044's Option E, and the half the first cut of
		// this change silently dropped: the same-namespace peer used to sit in
		// the serving rule with an empty PodSelector, so every co-resident pod
		// could reach 8012/8013 — co-resident zones calling each other's app pods
		// synchronously, which the SCS contract permits only via the browser or
		// async events. Legitimate in-cluster calls address the ksvc URL and
		// arrive via the Kourier gateway pods (wherever the install puts them:
		// kourier-system, knative-serving or knative-serving-ingress), so the
		// same-namespace peer is needed ONLY for metric scraping.
		nn := reconcileApp("np-scoped-peer", nil)

		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, policyName(nn.Name), np)).To(Succeed())
		Expect(np.Spec.Ingress).To(HaveLen(4))

		// Classify each rule by its peer role.
		portsOf := func(rule networkingv1.NetworkPolicyIngressRule) []int32 {
			var out []int32
			for _, p := range rule.Ports {
				Expect(p.Port).NotTo(BeNil())
				Expect(p.EndPort).To(BeNil(), "a port RANGE reopens what the allowlist closes")
				out = append(out, p.Port.IntVal)
			}
			return out
		}
		sameNsRules, servingRules, autoscalerRules := 0, 0, 0
		for _, rule := range np.Spec.Ingress {
			hasSameNs, hasScrapeLabel, hasAutoscaler := false, false, false
			for _, peer := range rule.From {
				if peer.NamespaceSelector == nil && peer.PodSelector != nil {
					hasSameNs = true
				}
				if peer.NamespaceSelector != nil {
					if _, ok := peer.NamespaceSelector.MatchLabels[metricsScrapeNamespaceLabel]; ok {
						hasScrapeLabel = true
					}
				}
				if peer.PodSelector != nil && peer.PodSelector.MatchLabels["app"] == "autoscaler" {
					hasAutoscaler = true
				}
			}
			// The #735 scrape rule has its own dedicated spec below; classify it out
			// here rather than letting it masquerade as a system rule.
			if hasScrapeLabel {
				continue
			}
			switch {
			case hasSameNs:
				sameNsRules++
				By("the same-namespace rule admits metrics ports ONLY")
				Expect(portsOf(rule)).To(ConsistOf(int32(9090), int32(9464)),
					"a same-namespace peer that can reach a serving port is the SCS contract leak")
			case hasAutoscaler:
				autoscalerRules++
				By("the autoscaler rule admits queue-proxy metrics port 9090 ONLY (#2494)")
				Expect(portsOf(rule)).To(ConsistOf(int32(9090)))
			default:
				servingRules++
				By("the activator + Kourier gateway rule carries the serving ports ONLY")
				Expect(portsOf(rule)).To(ConsistOf(int32(8012), int32(8013), int32(8112)))
			}
		}
		Expect(sameNsRules).To(Equal(1), "expected exactly one same-namespace rule")
		Expect(autoscalerRules).To(Equal(1), "expected exactly one autoscaler metrics rule")
		Expect(servingRules).To(Equal(1), "expected exactly one activator/kourier serving rule")
	})

	It("admits a LABELLED monitoring namespace on the metrics ports only (#735)", func() {
		// The operator ships its own PodMonitor (config/prometheus/app-podmonitor.yaml)
		// in the `system` namespace with `namespaceSelector: any`, scraping :9464
		// across every namespace. The policy admitted no third namespace, so on a
		// policy-enforcing CNI the operator's OWN scrape path was denied — found by
		// both design gates while reviewing ADR-0044's Option E, and invisible until
		// then because flannel (OKE GA, OrbStack) enforces nothing.
		//
		// Opt-in by LABEL rather than by a hardcoded namespace name: the operator
		// cannot know where a user runs Prometheus, and guessing would either miss
		// most clusters or silently widen the policy for everyone. A cluster that
		// labels no namespace keeps exactly the previous posture.
		nn := reconcileApp("np-scrape", nil)

		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, policyName(nn.Name), np)).To(Succeed())

		var scrapeRule *networkingv1.NetworkPolicyIngressRule
		for i := range np.Spec.Ingress {
			for _, peer := range np.Spec.Ingress[i].From {
				if peer.NamespaceSelector == nil {
					continue
				}
				if _, ok := peer.NamespaceSelector.MatchLabels[metricsScrapeNamespaceLabel]; ok {
					scrapeRule = &np.Spec.Ingress[i]
				}
			}
		}
		Expect(scrapeRule).NotTo(BeNil(),
			"no ingress rule admits a namespace labelled %s — the operator's own PodMonitor scrape stays denied",
			metricsScrapeNamespaceLabel)

		By("the scrape rule admits METRICS ports only — never the serving ports")
		var ports []int32
		for _, p := range scrapeRule.Ports {
			Expect(p.Port).NotTo(BeNil())
			Expect(p.EndPort).To(BeNil(), "a port RANGE reopens what the allowlist closes")
			ports = append(ports, p.Port.IntVal)
		}
		// 9464 ONLY, narrower than the same-namespace rule: the shipped PodMonitor
		// targets 9464, so admitting queue-proxy's 9090 across namespaces would be
		// breadth without a requirement (code review). Both halves: the port that
		// IS needed is present, and nothing else is.
		Expect(ports).To(ConsistOf(int32(9464)),
			"a monitoring namespace gets the APP metrics port only — never the serving ports, and not queue-proxy's 9090")

		By("the selector matches the label EXPLICITLY: an empty selector would admit every namespace")
		for _, peer := range scrapeRule.From {
			if peer.NamespaceSelector == nil {
				continue
			}
			Expect(peer.NamespaceSelector.MatchLabels).To(HaveKeyWithValue(metricsScrapeNamespaceLabel, "true"),
				"an empty or wildcard selector here would admit EVERY namespace, turning a scoped grant into a blanket one")
		}
	})

	It("creates the NetworkPolicy when Security.NetworkPolicy is explicitly true", func() {
		nn := reconcileApp("np-explicit-true", &appsv1alpha1.SecuritySpec{NetworkPolicy: ptr.To(true)})

		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, policyName(nn.Name), np)).To(Succeed())
		Expect(np.Spec.PodSelector.MatchLabels).To(HaveKeyWithValue("serving.knative.dev/service", nn.Name))
	})

	It("does not create the NetworkPolicy when Security.NetworkPolicy is false", func() {
		nn := reconcileApp("np-disabled", &appsv1alpha1.SecuritySpec{NetworkPolicy: ptr.To(false)})

		np := &networkingv1.NetworkPolicy{}
		err := k8sClient.Get(ctx, policyName(nn.Name), np)
		Expect(errors.IsNotFound(err)).To(BeTrue(), "expected no NetworkPolicy when disabled")
	})

	It("deletes a previously-created NetworkPolicy when toggled to false", func() {
		nn := reconcileApp("np-toggle", nil)

		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, policyName(nn.Name), np)).To(Succeed())

		By("toggling NetworkPolicy off and re-reconciling")
		app := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, app)).To(Succeed())
		app.Spec.Security = &appsv1alpha1.SecuritySpec{NetworkPolicy: ptr.To(false)}
		Expect(k8sClient.Update(ctx, app)).To(Succeed())

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		err = k8sClient.Get(ctx, policyName(nn.Name), np)
		Expect(errors.IsNotFound(err)).To(BeTrue(), "expected NetworkPolicy removed after toggle to false")
	})
})
