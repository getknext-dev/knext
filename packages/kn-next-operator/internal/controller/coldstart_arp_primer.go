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
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ConditionArpPrimerReady surfaces (non-fatally, same shape as
// ConditionImageCacheReady) whether the opt-in spec.coldStart.arpPrimer
// init container actually made it onto the cluster. Dropped entirely when
// the field is off, unless it was previously present (#98 no-op guard).
const ConditionArpPrimerReady = "ArpPrimerReady"

// arpPrimerFeatureGateRejectionText is Knative Serving's EXACT validation
// message (knative.dev/serving@v0.48.0, pkg/apis/serving/k8s_validation.go,
// validateInitContainers) when kubernetes.podspec-init-containers is not
// Enabled — which is the upstream DEFAULT. It is deliberately NOT a prefix
// match on "init container" alone: that also appears in unrelated,
// genuinely-fatal validation errors (e.g. a duplicate container name), and
// this string is specific to the feature-gate-off case.
//
// Re-check this string against the cluster's actual Knative Serving minor
// version if the classification below stops matching — it is a literal
// upstream message, not a contract knext owns.
const arpPrimerFeatureGateRejectionText = "pod spec support for init-containers is off"

// arpPrimerRejectionRequeueAfter bounds the retry when Knative rejects the
// init container: same value as imagePrewarmFailureRequeueAfter (2m) — a
// different opt-in cold-start feature, same "non-fatal, bounded retry"
// shape. Kept as its own named constant so the two features' retry cadences
// can diverge later without an unrelated rename.
const arpPrimerRejectionRequeueAfter = 2 * time.Minute

// coldStartState carries the observed outcome of rendering
// spec.coldStart.arpPrimer into the pure status verdict — mirroring
// imageCacheState (image_prewarm.go) and netpolEnforcementState
// (netpol_enforcement.go). computeStatusVerdict never does cluster I/O or
// string-matches an error itself; Reconcile classifies the CreateOrUpdate
// outcome once and hands the verdict a plain struct.
type coldStartState struct {
	// enabled mirrors arpPrimerEnabled(app).
	enabled bool
	// rejectedMsg is non-empty when Knative's admission webhook rejected the
	// ksvc update specifically BECAUSE of the arpPrimer init container (the
	// kubernetes.podspec-init-containers feature flag is off on this
	// cluster). Reconcile does NOT abort the pass on this specific,
	// classified rejection — the already-serving revision is unaffected,
	// since the rejected update never reaches the server — so this is the
	// only place the failure becomes visible.
	rejectedMsg string
}

// isArpPrimerFeatureGateRejection reports whether err is Knative's admission
// rejection of the arpPrimer init container specifically because
// kubernetes.podspec-init-containers is not enabled on this cluster — as
// opposed to any OTHER reason the ksvc apply might fail (quota, a malformed
// image, an unrelated validation error, a network blip). Reconcile must
// keep every other failure mode's existing abort-and-requeue behaviour
// untouched; only this one, narrowly-classified case is treated as
// non-fatal.
func isArpPrimerFeatureGateRejection(err error) bool {
	return err != nil && strings.Contains(err.Error(), arpPrimerFeatureGateRejectionText)
}

// ARP primer (spike, issue #1760, spec.coldStart.arpPrimer).
//
// Mechanism (see the 2026-10-01 design study,
// .claude/research/cold-start-design-study-2026-10-01.md §1/§7c): on a
// flannel VXLAN node whose pod-IP allocator has wrapped, a stale ARP /
// neighbour entry for the recycled IP can make a freshly-scheduled pod
// unreachable from the node's own host namespace until the pod itself sends
// an outbound frame — Linux's delay_first_probe_time (5s) plus
// ucast_solicit*retrans_time (3x1s) adds up to the observed ~7.5-8s
// blackhole. ANY outbound frame from the pod's veth is sufficient to refresh
// the node's neighbour entry; a gratuitous-ARP announce is NOT required, so
// this uses a single best-effort UDP datagram, which needs no NET_RAW.
//
// Image choice: reuses the ALREADY-TRUSTED, digest-pinned, static busybox
// image image_prewarm.go pins for its own init container
// (prewarmHelperImage) — no NEW image enters the trust/scan surface, and it
// is plausibly already cache-warm on a node that has run ANY app with
// imagePrewarm or this primer before. Busybox's `nc` applet supports `-u`
// for a UDP send.
const arpPrimerContainerName = "arp-primer"

// arpPrimerTargetEnvVar carries the pod's own node IP via the Downward API
// (status.hostIP is one of the few fieldRef paths the API server allows —
// container image is NOT, which is why this reuses prewarmHelperImage
// rather than deriving an operator-self-image reference). The primer sends
// its datagram here: any destination works for refreshing the node's
// neighbour table, and the node's own IP is always topologically reachable,
// unlike guessing the CNI gateway address.
const arpPrimerTargetEnvVar = "KNEXT_ARP_PRIMER_TARGET"

// arpPrimerEnabled reports whether spec.coldStart.arpPrimer is explicitly
// true. nil or false => disabled (default-off for this spike).
func arpPrimerEnabled(app *appsv1alpha1.NextApp) bool {
	return app.Spec.ColdStart != nil && app.Spec.ColdStart.ArpPrimer != nil && *app.Spec.ColdStart.ArpPrimer
}

// buildArpPrimerInitContainer renders the hardened init container. It is a
// PURE builder — no cluster I/O, no owner reference — so it is unit
// testable without a scheme, matching the convention of the other
// buildDesiredKsvc helpers in this package.
//
// Security posture (every requirement from the issue, all hardened):
//   - digest-pinned image (prewarmHelperImage, already audited/scanned);
//   - runAsNonRoot + a fixed non-root UID (prewarmNonRootUID, shared with
//     image_prewarm.go's own busybox init container);
//   - AllowPrivilegeEscalation: false;
//   - all Linux capabilities dropped, none added — a plain UDP send needs
//     NO capabilities, in particular no NET_RAW (gratuitous ARP would need
//     NET_RAW; a UDP datagram does not, which is why this is the chosen
//     mechanism over an ARP announce);
//   - readOnlyRootFilesystem: true — the command only reads argv/env, writes
//     nothing;
//   - no ServiceAccount token: handled at the POD level
//     (AutomountServiceAccountToken=false, nextapp_controller.go:~454) and
//     reinforced here by mounting nothing into this container.
func buildArpPrimerInitContainer() corev1.Container {
	return corev1.Container{
		Name:  arpPrimerContainerName,
		Image: prewarmHelperImage,
		// A single best-effort UDP datagram to the pod's own node. `|| true`
		// means a closed/filtered port (the common case — nothing is
		// listening on the chosen port) never fails the init container: the
		// goal is the OUTBOUND frame leaving the veth, not a successful
		// round trip.
		Command: []string{"sh", "-c", "echo | nc -u -w1 \"$KNEXT_ARP_PRIMER_TARGET\" 9 || true"},
		Env: []corev1.EnvVar{
			{
				Name: arpPrimerTargetEnvVar,
				ValueFrom: &corev1.EnvVarSource{
					FieldRef: &corev1.ObjectFieldSelector{
						FieldPath: "status.hostIP",
					},
				},
			},
		},
		SecurityContext: &corev1.SecurityContext{
			RunAsNonRoot:             ptr.To(true),
			RunAsUser:                ptr.To(prewarmNonRootUID),
			AllowPrivilegeEscalation: ptr.To(false),
			ReadOnlyRootFilesystem:   ptr.To(true),
			Capabilities: &corev1.Capabilities{
				Drop: []corev1.Capability{"ALL"},
			},
		},
	}
}
