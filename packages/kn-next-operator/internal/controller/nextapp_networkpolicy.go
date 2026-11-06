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
	"maps"

	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	knativenetworking "knative.dev/serving/pkg/networking"
)

// networkPolicyEnabled reports whether the in-cluster NetworkPolicy should be
// reconciled for this NextApp. Semantics: nil (unset) or true => enabled
// (DEFAULT-ON); false => disabled.
func networkPolicyEnabled(nextApp *appsv1alpha1.NextApp) bool {
	if nextApp.Spec.Security == nil || nextApp.Spec.Security.NetworkPolicy == nil {
		return true
	}
	return *nextApp.Spec.Security.NetworkPolicy
}

// The ingress port allowlist (ADR-0044), derived from KNATIVE'S OWN EXPORTED
// CONSTANTS rather than hand-enumerated literals.
//
// The architect gate required this after the hand-written list missed
// BackendHTTPSPort (8112) — a miss that, on a policy-enforcing CNI with
// system-internal-tls on, is an outage rather than a weaker policy. Importing
// the constants means a knative upgrade that renumbers or adds a port shows up
// as a compile-time change here instead of a silent production hole.
//
// Deliberately NOT included: QueueAdminPort (8022), which v0.48 no longer puts
// on the pod, and the app's own user port, which queue-proxy reaches over
// pod-local loopback where no NetworkPolicy applies.
var (
	queueProxyHTTPPort  = int32(knativenetworking.BackendHTTPPort)
	queueProxyH2CPort   = int32(knativenetworking.BackendHTTP2Port)
	queueProxyHTTPSPort = int32(knativenetworking.BackendHTTPSPort)
	// queueProxyMetricsPort is knative's AutoscalingQueueMetricsPort (9090).
	queueProxyMetricsPort = int32(knativenetworking.AutoscalingQueueMetricsPort)
	// appMetricsPort is the knext runtime's OWN metrics listener — a LITERAL,
	// deliberately NOT knativenetworking.UserQueueMetricsPort (#951). It used to
	// be exactly that alias (9091), which is the port queue-proxy ITSELF binds
	// for its user-metrics server whenever serving's
	// `metrics.request-metrics-backend-destination` is active — the stock
	// config-observability default. App and sidecar raced for :9091 in the
	// shared pod netns, the app lost with EADDRINUSE, and every scaffolded app
	// crash-looped on a default Knative install (S3-V Finding C-2). 9464 is the
	// conventional OpenTelemetry Prometheus-exporter port and belongs to no
	// queue-proxy listener. Kept in lockstep with the runtime entries' default,
	// the prometheus.io/port annotation, and the shipped PodMonitor by
	// metrics-port-lockstep.test.ts — change them together or not at all.
	appMetricsPort = int32(9464)
)

// desiredIngressRules is the ingress half of the app NetworkPolicy, as a PURE
// function of nothing — the rules are identical for every app (only the
// podSelector varies), so they can be rendered outside a reconcile.
//
// EXTRACTED so the enforcement drill applies the OPERATOR's rules rather than a
// hand-copy. Spec review caught that the drill's inline YAML could drift from
// the operator silently, which would leave the drill passing while the shipped
// policy changed. cmd/policygen renders these into a full policy the drill
// applies, so operator drift now reddens the drill.
func desiredIngressRules() []networkingv1.NetworkPolicyIngressRule {
	return []networkingv1.NetworkPolicyIngressRule{
		{
			// PORT ALLOWLIST (ADR-0044) + POD-SCOPED PEERS (#2494). Without the
			// port allowlist the rule admits EVERY port, so any admitted peer
			// dials the app container's user port directly — skipping
			// queue-proxy and, with it, the containerConcurrency bound and the
			// Go HTTP parser. That is the in-cluster bypass ADR-0044 measured;
			// restricting ports is the only control that closes it without
			// touching the runtime.
			//
			// The user port is deliberately ABSENT: queue-proxy reaches it over
			// pod-local loopback (127.0.0.1:USER_PORT), which no NetworkPolicy
			// governs, so excluding it costs nothing legitimate.
			//
			// 8112 is NOT optional either, and its absence is an OUTAGE, not a
			// hardening: knative v0.48's queue.go appends queueHTTPSPort to
			// EVERY revision pod unconditionally
			// (`ports = append(ports, servingPort, queueHTTPSPort)`), the SKS
			// targets it, and the activator and Kourier gateway dial it when
			// system-internal-tls is on. Omitting it makes every app unreachable
			// on a policy-enforcing CNI with internal TLS enabled.
			//
			// PEER NARROWING (#2494): only Knative activator pods
			// (`knative-serving` AND `app=activator`) and Kourier gateway pods
			// (`app=3scale-kourier-gateway` in `kourier-system`, `knative-serving`
			// or `knative-serving-ingress`, one peer each) may reach the
			// serving ports. Other control-plane pods in `knative-serving`
			// (controller, webhook, autoscaler, net-kourier-controller) and
			// non-gateway pods in `kourier-system` are excluded. Non-Kourier
			// ingress layers are deliberately NOT supported by the default
			// policy; operators on Istio/Contour/Gateway API set
			// spec.security.networkPolicy:false and bring their own policy.
			//
			// CNI CAVEAT: flannel (OKE GA, OrbStack) ships no NetworkPolicy
			// controller, so there this object is declarative-only and enforces
			// nothing. Enforcement needs a policy-capable CNI (Calico/Cilium).
			Ports: []networkingv1.NetworkPolicyPort{
				{Port: new(intstr.FromInt32(queueProxyHTTPPort))},
				{Port: new(intstr.FromInt32(queueProxyH2CPort))},
				{Port: new(intstr.FromInt32(queueProxyHTTPSPort))},
			},
			From: append([]networkingv1.NetworkPolicyPeer{
				activatorPeer(),
			}, kourierGatewayPeers()...),
		},
		// SECOND RULE — Knative autoscaler scrape of queue-proxy metrics (#2494).
		//
		// Narrowing `knative-serving` to `app=activator` alone would silently
		// break autoscaling: the autoscaler scrapes queue-proxy on 9090
		// (AutoscalingQueueMetricsPort), and a dropped scrape stalls scale-up
		// with no error on the request path. Admitting `app=autoscaler` on 9090
		// ONLY keeps autoscaling working while denying a compromised autoscaler
		// pod access to the serving ports (8012/8013/8112) and app metrics (9464).
		{
			Ports: []networkingv1.NetworkPolicyPort{
				{Port: new(intstr.FromInt32(queueProxyMetricsPort))},
			},
			From: []networkingv1.NetworkPolicyPeer{
				autoscalerPeer(),
			},
		},
		// THIRD RULE — the same-namespace peer, SCOPED (ADR-0044).
		//
		// It used to sit in the serving rule with an empty PodSelector, which
		// meant every co-resident pod could reach the SERVING ports. That is
		// the SCS contract leak ADR-0044 names: co-resident zones calling each
		// other's app pods synchronously, when the zone contract permits only
		// the browser and async events. Legitimate in-cluster calls to a knext
		// app address its ksvc URL and are routed by Kourier, so they arrive
		// from the Kourier gateway peer above — the same-namespace peer is NOT
		// needed for app traffic at all.
		//
		// What it IS needed for is metric scraping by a Prometheus running
		// beside the app (the operator stamps prometheus.io/port=9464; CAVEAT:
		// the runtime lets an app override its metrics port via METRICS_PORT,
		// whereas this allowlist is fixed at 9464). So the peer survives,
		// narrowed to the metrics ports.
		//
		// Scoped by PORT rather than by pod LABEL deliberately: the operator
		// cannot know a user's monitoring pod labels, and guessing them would
		// break scraping for every cluster whose Prometheus is labelled
		// differently. Port-scoping achieves the same isolation with no
		// assumption about the user's deployment.
		{
			Ports: []networkingv1.NetworkPolicyPort{
				{Port: new(intstr.FromInt32(queueProxyMetricsPort))},
				{Port: new(intstr.FromInt32(appMetricsPort))},
			},
			From: []networkingv1.NetworkPolicyPeer{
				// An empty PodSelector matches all pods in the policy's own
				// namespace (NamespaceSelector nil => same namespace).
				{PodSelector: &metav1.LabelSelector{}},
			},
		},
		// FOURTH RULE — cross-namespace metric scraping, label-gated (#735).
		//
		// The APP metrics port ONLY — deliberately narrower than the
		// same-namespace rule above. #735's motivation is the operator's shipped
		// PodMonitor, which targets 9464 and nothing else
		// (config/prometheus/app-podmonitor.yaml), so admitting queue-proxy's
		// autoscaling metrics (9090) across namespaces would be allowlist breadth
		// with no driving requirement. Code review caught that; "match broadly,
		// exclude narrowly" cuts the other way for a grant.
		//
		// HONEST SCOPE — this is namespace RBAC, not a per-app privilege
		// boundary. The label sits on a CLUSTER-SCOPED Namespace object, so the
		// grantor is whoever holds `update namespaces` (normally cluster-admin,
		// but any platform with self-service namespace creation lets a tenant
		// create-and-label its own). Once labelled, EVERY pod in that namespace —
		// not merely Prometheus — can scrape :9464 on EVERY knext app in the
		// cluster, and an individual NextApp owner has no per-app opt-out short
		// of disabling their whole policy. There is no PodSelector here precisely
		// because the operator cannot know a user's Prometheus labels.
		//
		// And a second policy CANNOT narrow this: NetworkPolicies are additive, so
		// they union allow-rules rather than intersecting them. The only narrowing
		// lever is spec.security.networkPolicy:false plus a bring-your-own policy.
		// An earlier comment here claimed otherwise — a false mitigation in a
		// security control, which the architect gate blocked on.
		{
			Ports: []networkingv1.NetworkPolicyPort{
				{Port: new(intstr.FromInt32(appMetricsPort))},
			},
			From: []networkingv1.NetworkPolicyPeer{
				{NamespaceSelector: &metav1.LabelSelector{
					MatchLabels: map[string]string{metricsScrapeNamespaceLabel: lcTrue},
				}},
			},
		},
	}
}

// DesiredNetworkPolicy renders the complete policy the operator reconciles for
// an app. Exported for cmd/policygen (the enforcement drill's source of truth).
func DesiredNetworkPolicy(appName, namespace string) *networkingv1.NetworkPolicy {
	return &networkingv1.NetworkPolicy{
		TypeMeta: metav1.TypeMeta{APIVersion: "networking.k8s.io/v1", Kind: "NetworkPolicy"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      appName + "-allow-ingress",
			Namespace: namespace,
			Labels: map[string]string{
				"app":          appName,
				"generated-by": "kn-next-operator",
			},
		},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{
				MatchLabels: map[string]string{"serving.knative.dev/service": appName},
			},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress:     desiredIngressRules(),
		},
	}
}

// metricsScrapeNamespaceLabel opts a namespace into scraping app metrics ACROSS
// namespaces (#735).
//
// The operator ships its own PodMonitor (config/prometheus/app-podmonitor.yaml)
// in the `system` namespace with `namespaceSelector: any`, so its scrape of
// :9464 is cross-namespace — and the policy admitted no third namespace, which
// meant the operator's OWN metrics path was denied on any policy-enforcing CNI.
// Both design gates surfaced this while reviewing ADR-0044; it stayed invisible
// because flannel (OKE GA, OrbStack) enforces no NetworkPolicy at all.
//
// Opt-in BY LABEL rather than by a hardcoded namespace: the operator cannot know
// where a user runs Prometheus. A cluster that labels nothing keeps exactly the
// previous posture, so this widens no one's policy by default.
//
// Deliberately NOT a CRD field: growing `spec.security.networkPolicy` from *bool
// into a struct is a public-API change, which ADR-0017 (v1alpha1, no conversion
// webhook) and the #548 upgrade-order rule make gated design work. A namespace
// label needs neither.
const metricsScrapeNamespaceLabel = "knext.dev/metrics-scrape"

// reconcileNetworkPolicy emits a Kubernetes NetworkPolicy that restricts ingress
// to the app's pods to in-cluster sources only: Knative activator and Kourier
// gateway pods on serving ports, Knative autoscaler pods on 9090, the app's own
// namespace on metrics ports, and opt-in metrics-scrape namespaces on 9464.
// This is defense-in-depth for the (already Bearer-authed) mutating
// cache endpoints (`POST /api/cache/invalidate`, `DELETE /api/cache/events`).
//
// IMPORTANT (honesty): a NetworkPolicy is L3/L4 — it filters by source pod/
// namespace at the network layer, NOT by HTTP path. It therefore CANNOT isolate a
// specific route; it makes the whole POD unreachable for direct traffic from
// outside the cluster / disallowed namespaces. True per-path isolation would
// require a separate internal-only route. Enforcement also depends on the cluster
// CNI supporting NetworkPolicy (no-op where unsupported).
//
// The policy is owner-referenced to the NextApp so it is garbage-collected on
// delete. When disabled (spec.security.networkPolicy=false), any previously
// created policy is deleted.
func (r *NextAppReconciler) reconcileNetworkPolicy(ctx context.Context, nextApp *appsv1alpha1.NextApp) error {
	np := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name + "-allow-ingress",
			Namespace: nextApp.Namespace,
		},
	}

	if !networkPolicyEnabled(nextApp) {
		// Disabled: best-effort delete of any previously-created policy.
		if err := r.Delete(ctx, np); err != nil && !errors.IsNotFound(err) {
			return err
		}
		return nil
	}

	// The reconciler and cmd/policygen build from ONE definition. The rules were
	// unified first; the system-designer gate pointed out that podSelector and
	// labels were still built independently, so the drill could have proved
	// enforcement for a selector the reconciler no longer wrote. Both halves now
	// come from DesiredNetworkPolicy.
	desired := DesiredNetworkPolicy(nextApp.Name, nextApp.Namespace)
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, np, func() error {
		if np.Labels == nil {
			np.Labels = make(map[string]string)
		}
		maps.Copy(np.Labels, desired.Labels)
		np.Spec = desired.Spec
		return ctrl.SetControllerReference(nextApp, np, r.Scheme)
	})
	return err
}
