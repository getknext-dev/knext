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
	"fmt"
	"sort"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// NetworkPolicy-enforcement detection (#744). The operator reconciles a
// default-on NetworkPolicy (ADR-0044), but whether anything ENFORCES it is a
// property of the cluster's CNI — flannel (OKE GA, OrbStack) ships no
// NetworkPolicy controller, so there the policy is declarative only. Nothing
// used to observe that: the operator wrote the policy, reported success, and a
// security control believed to be in force was silently inert. This file
// detects the cluster's enforcement posture from CNI DaemonSet signatures and
// carries it into the status verdict as the NetworkPolicyEnforced condition.
//
// Detection is signature-based and deliberately HONEST about its confidence:
// there is no Kubernetes API that answers "is NetworkPolicy enforced", and an
// active probe (canary pods + a blocked dial) would be cluster-mutating —
// which ADR-0001 confines to the CR path. So: a known policy-controller
// DaemonSet => enforced; flannel alone => likely-unenforced; anything else
// (including a failed DaemonSet list) => unknown, which consumers must treat
// as unenforced, never as enforced.
//
// The same signature table exists in the CLI's read-only doctor check
// (packages/kn-next/src/cli/doctor.ts, classifyCNIEnforcement) — keep the two
// lists in sync when adding a CNI.

// ConditionNetworkPolicyEnforced reports whether the cluster's CNI enforces
// the NetworkPolicy the operator reconciles: True (a policy controller is
// running), False (flannel alone — the policy is declarative only), Unknown
// (cannot determine; treat as unenforced). Status-only: no spec/schema change.
const ConditionNetworkPolicyEnforced = "NetworkPolicyEnforced"

const (
	// ReasonPolicyControllerDetected: a known NetworkPolicy-enforcing agent
	// was found — the reconciled policy is actually in force.
	ReasonPolicyControllerDetected = "PolicyControllerDetected"
	// ReasonNoPolicyController: flannel detected with no policy controller —
	// the reconciled policy is written but enforces nothing.
	ReasonNoPolicyController = "NoPolicyController"
	// ReasonEnforcementUnknown: no recognizable CNI signature (or the read
	// failed) — honesty demands Unknown, never a guess of enforced.
	ReasonEnforcementUnknown = "CannotDetermine"
)

// netpolEnforcement is the three-valued detection outcome. The zero value is
// unknown, so an unpopulated state can never claim enforcement.
type netpolEnforcement int

const (
	// netpolEnforcementUnknown: no known CNI signature matched, or the
	// DaemonSet read failed — the honest fallback. Treat as unenforced.
	netpolEnforcementUnknown netpolEnforcement = iota
	// netpolEnforcementLikelyUnenforced: a CNI known to ship NO NetworkPolicy
	// controller (flannel) was detected, and no policy controller was.
	netpolEnforcementLikelyUnenforced
	// netpolEnforcementEnforced: a known NetworkPolicy-enforcing agent is
	// running on the cluster.
	netpolEnforcementEnforced
)

// netpolEnforcementState carries the detection outcome into
// computeStatusVerdict, mirroring imageCacheState: the pure verdict never does
// I/O, so the reconciler observes the cluster and hands the result in.
type netpolEnforcementState struct {
	// enabled mirrors networkPolicyEnabled(app): when the policy itself is
	// switched off (spec.security.networkPolicy=false) there is nothing whose
	// enforcement could be reported, and the condition is dropped.
	enabled bool
	// verdict is the three-valued detection outcome.
	verdict netpolEnforcement
	// evidence names the DaemonSet(s) behind the verdict ("calico-node
	// (kube-system)"), sorted for determinism, or "" when nothing matched —
	// message stability is load-bearing for the #98 no-op status guard.
	evidence string
}

// dsRef is the minimal DaemonSet identity the classifier consumes.
type dsRef struct {
	namespace string
	name      string
}

// enforcingAgentDS maps DaemonSet names of NetworkPolicy-ENFORCING agents to
// the CNI they identify. Exact-name matches, because these are the names the
// upstream install manifests ship. Canal counts: it pairs flannel networking
// with calico's felix, which does enforce.
var enforcingAgentDS = map[string]string{
	"calico-node":  "Calico",
	"cilium":       "Cilium",
	"kube-router":  "kube-router",
	"weave-net":    "Weave Net",
	"antrea-agent": "Antrea",
	"canal":        "Canal (Calico policy)",
}

// flannelDS reports whether a DaemonSet name identifies flannel, which ships
// NO NetworkPolicy controller. Substring match: upstream manifests have used
// "kube-flannel-ds", per-arch "kube-flannel-ds-<arch>", and plain "flannel".
func flannelDS(name string) bool {
	return strings.Contains(name, "flannel")
}

// classifyCNIEnforcement is the PURE classification seam: given the cluster's
// DaemonSets, return the enforcement verdict and its evidence string.
//
// Precedence: any enforcing agent wins (canal clusters also run a flannel
// DaemonSet); flannel alone is likely-unenforced; nothing recognized is
// unknown — never guessed into either determinate state. Evidence is sorted
// so the same cluster always yields the same string (#98 message stability).
func classifyCNIEnforcement(daemonSets []dsRef) (netpolEnforcement, string) {
	var enforcing, flannel []string
	for _, ds := range daemonSets {
		if cni, ok := enforcingAgentDS[ds.name]; ok {
			enforcing = append(enforcing, fmt.Sprintf("%s DaemonSet %s (%s)", cni, ds.name, ds.namespace))
		} else if flannelDS(ds.name) {
			flannel = append(flannel, fmt.Sprintf("flannel DaemonSet %s (%s)", ds.name, ds.namespace))
		}
	}
	switch {
	case len(enforcing) > 0:
		sort.Strings(enforcing)
		return netpolEnforcementEnforced, strings.Join(enforcing, "; ")
	case len(flannel) > 0:
		sort.Strings(flannel)
		return netpolEnforcementLikelyUnenforced, strings.Join(flannel, "; ")
	default:
		return netpolEnforcementUnknown, ""
	}
}

// detectNetworkPolicyEnforcement lists the cluster's DaemonSets and classifies
// them. A failed list is UNKNOWN with no evidence — a read error is not
// evidence of anything, least of all enforcement.
func (r *NextAppReconciler) detectNetworkPolicyEnforcement(ctx context.Context) (netpolEnforcement, string) {
	list := &appsv1.DaemonSetList{}
	if err := r.List(ctx, list, &client.ListOptions{}); err != nil {
		return netpolEnforcementUnknown, ""
	}
	refs := make([]dsRef, 0, len(list.Items))
	for _, ds := range list.Items {
		refs = append(refs, dsRef{namespace: ds.Namespace, name: ds.Name})
	}
	return classifyCNIEnforcement(refs)
}
