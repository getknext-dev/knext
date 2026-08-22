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
	"time"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// This file holds the PURE status-verdict computation extracted from Reconcile
// (#254): given the NextApp (spec + prior status), the child ksvc's status, the
// outcome of the imperative database phase, the pinned-revision check result,
// and a clock, computeStatusVerdict returns everything the reconciler must
// apply — conditions (in append order), condition removals, transition-gated
// events, and the requeue. Reconcile is fetch → reconcile children → compute
// (pure) → applyStatusVerdict. No I/O happens here, so the verdict is fully
// unit-testable without envtest (status_verdict_test.go).

// databaseMode enumerates the two shapes of spec.database the reconciler
// distinguishes (steps 0b / 0c): BYO Secret binding (ADR-0019) or no database at
// all. The operator-managed provisioning mode was removed (ADR-0025) — knext is
// engine-agnostic and provisions no database.
type databaseMode int

const (
	// databaseModeNone: spec.database absent/emptied — the status must stop
	// claiming a database.
	databaseModeNone databaseMode = iota
	// databaseModeBound: spec.database.secretRef — an EXISTING same-namespace
	// Secret is bound as DATABASE_URL; no provisioning, no hard-gate (ADR-0019).
	databaseModeBound
)

// databaseCheckState carries the outcome of the database binding phase into the
// verdict. Only mode is consulted (BYO binding never fails or gates — a missing
// Secret surfaces on the pod as CreateContainerConfigError, envMap semantics).
type databaseCheckState struct {
	mode databaseMode
}

// revisionCheck is the three-valued outcome of the pinned-revision existence
// GET (ADR-0014 follow-up): exists (zero value) / NotFound / unknown. Only a
// real NotFound may degrade (after the stall-window race guard); a transient
// GET error is NOT evidence the revision is gone, so the verdict keeps the
// prior PinnedRevisionNotFound verdict rather than flip-flopping the condition
// on API hiccups.
type revisionCheck struct {
	notFound bool
	unknown  bool
}

// verdictEvent is a Kubernetes Event the verdict wants emitted. Transition
// gating (fire only when the verdict newly enters a state) is already resolved
// by computeStatusVerdict — applyStatusVerdict emits these unconditionally.
type verdictEvent struct {
	eventType string
	reason    string
	message   string
}

// statusVerdict is the full outcome of one status computation.
//
// ORDER CONTRACT (#98): conditions are applied via apimeta.SetStatusCondition
// in slice order, and removeConditions before that. SetStatusCondition APPENDS
// unknown types, so this order determines the persisted conditions-slice order
// — which the #98 no-op guard DeepEquals against the observed status. Reordering
// entries would make a converged object's status write non-idempotent and
// reintroduce the idle hot-loop.
type statusVerdict struct {
	// removeConditions are condition types dropped from status (applied first).
	removeConditions []string
	// conditions are set in order; each carries the app's ObservedGeneration.
	conditions []metav1.Condition
	// events to emit (already transition-filtered — see verdictEvent).
	events []verdictEvent
	// requeueAfter bounds how long until the next re-evaluation (0 = none).
	requeueAfter time.Duration
}

// revalidationDeferred reports whether Kafka-based ISR revalidation was
// requested (spec.revalidation.queue == "kafka") but the operator must NOT
// provision a KafkaSource, because the `{app}-revalidator` consumer the source
// would sink into is not built (issue #95).
//
// It deliberately IGNORES spec.revalidation.provisionKafkaSource (#475). That
// opt-in used to flip this to false and let the reconciler create the source, on
// the premise that the user had deployed their own consumer — but that BYO path
// was never a real contract: the sink shape was never specified or tested, so
// the flag could only produce a source aimed at a Service that may never exist.
// The capability is therefore WITHDRAWN, and inertness is the instrument:
// rejecting the flag instead would narrow v1alpha1 in place (ADR-0017 §2.1) and,
// because the shared validator is also the fail-closed reconciler's gate, would
// stop the entire app from reconciling on operator upgrade with no user action.
//
// Consequence, deliberately: the KafkaSource block in Reconcile is unreachable
// through the guard it already has. Building the consumer (the open ADR-0016
// action item) is what makes this function consult the flag again.
func revalidationDeferred(app *appsv1alpha1.NextApp) bool {
	return app.Spec.Revalidation != nil && app.Spec.Revalidation.Queue == "kafka"
}

// provisionKafkaSourceRequested reports whether the app asks for the WITHDRAWN
// opt-in, which the operator ignores. Split from revalidationDeferred because
// the two answer different questions: "is revalidation deferred" (always, for
// kafka) versus "is the user asking for something that no longer does anything"
// (the case that must be reported loudly).
func provisionKafkaSourceRequested(app *appsv1alpha1.NextApp) bool {
	return app.Spec.Revalidation != nil &&
		ptr.Deref(app.Spec.Revalidation.ProvisionKafkaSource, false)
}

// computeStatusVerdict is the single, pure seam for the NextApp status verdict:
// the DatabaseReady composition (BYO bound, or none — managed provisioning was
// removed, ADR-0025), the honest-Ready roll-up from the child ksvc's own Ready
// condition, the pinned-revision verdict (with its three-valued check handling),
// the ingress-programming stall, the RevalidationDeferred surface, and the
// bounded requeues.
func computeStatusVerdict(
	app *appsv1alpha1.NextApp,
	ksvc *servingv1.Service,
	db databaseCheckState,
	rev revisionCheck,
	ic imageCacheState,
	np netpolEnforcementState,
	now time.Time,
) statusVerdict {
	var v statusVerdict

	// 0. BYO database binding (ADR-0019). Managed provisioning was removed
	// (ADR-0025): the only database surface is a bound existing Secret, or none.
	switch db.mode {
	case databaseModeBound:
		v.conditions = append(v.conditions, metav1.Condition{
			Type:               ConditionDatabaseReady,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: app.Generation,
			Reason:             "Bound",
			Message:            fmt.Sprintf("Bound existing Secret %q as DATABASE_URL", app.Spec.Database.SecretRef.Name),
		})
	default:
		// spec.database removed/emptied: drop the DatabaseReady condition so the
		// status stops claiming a database.
		v.removeConditions = append(v.removeConditions, ConditionDatabaseReady)
	}

	// 6a. Honest Ready: gate NextApp Ready on the CHILD Knative Service's OWN
	// readiness — not on the fact that we successfully wrote the ksvc. Writing the
	// ksvc spec says nothing about whether its pods actually came up: a NextApp
	// whose image is CrashLoopBackOff / ImagePullBackOff would otherwise report a
	// false-green Ready=True, misleading operators and rollback / traffic-split
	// automation during the exact incident they need to detect.
	//
	// We read the ksvc's "Ready" condition (knative's living condition set rolls
	// Configuration + Route readiness into it) and only mark NextApp Ready=True
	// when that is True. Otherwise Ready=False / Degraded=True with the ksvc's own
	// reason+message (the pull/crash detail), and we schedule a bounded RequeueAfter
	// so status converges toward real health instead of waiting solely on the
	// Owns(ksvc) watch (which may be quiet between status transitions).
	ksvcReadyCond := ksvc.Status.GetCondition(servingv1.ServiceConditionReady)
	ksvcReady := ksvcReadyCond.IsTrue()

	v.conditions = append(v.conditions, metav1.Condition{
		Type:               ConditionReconciling,
		Status:             metav1.ConditionFalse,
		ObservedGeneration: app.Generation,
		Reason:             "ReconcileSuccess",
		Message:            "Reconciliation complete",
	})

	if ksvcReady {
		v.conditions = append(v.conditions, metav1.Condition{
			Type:               ConditionReady,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: app.Generation,
			Reason:             "ReconcileSuccess",
			Message:            "NextApp reconciled successfully; Knative Service is Ready",
		})
		v.conditions = append(v.conditions, metav1.Condition{
			Type:               ConditionDegraded,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: app.Generation,
			Reason:             "ReconcileSuccess",
			Message:            "No errors detected",
		})
	} else {
		// Surface the ksvc's own reason/message so operators see the pull/crash
		// detail (e.g. ImagePullBackOff / RevisionFailed) directly on the NextApp.
		ksvcReason := "Pending"
		ksvcMessage := "Knative Service has not reported Ready yet"
		if ksvcReadyCond != nil {
			if ksvcReadyCond.Reason != "" {
				ksvcReason = ksvcReadyCond.Reason
			}
			if ksvcReadyCond.Message != "" {
				ksvcMessage = ksvcReadyCond.Message
			}
		}
		readyReason := "KnativeServiceNotReady"
		readyMessage := fmt.Sprintf("Knative Service is not Ready (%s): %s",
			ksvcReason, ksvcMessage)
		// Loud failure on silent ingress stalls (#208): Knative's own message
		// ("Ingress has not yet been reconciled.") reads as "wait longer" even
		// when NO ingress controller serves the configured class and the route
		// will never program. Past the window, replace the opaque pending state
		// with a specific reason + Warning event naming the likely fix.
		//
		// Churn guards: the condition message is STATIC ("for more than <window>")
		// — embedding the live elapsed would make every 30s requeue produce a new
		// message, defeating the #98 no-op status guard with a status write +
		// self-watch echo per requeue. The live elapsed goes in the EVENT only,
		// and the event fires only on TRANSITION into the stall (the previous
		// Ready reason wasn't already IngressNotProgrammed), not on every pass.
		// Pinned-revision verdict (ADR-0014) — takes precedence over the generic
		// ingress-stall check because it is the more specific, more actionable
		// diagnosis. Same churn discipline as the ingress stall: STATIC message
		// (derived only from spec fields, so the #98 no-op guard holds), Warning
		// event on TRANSITION only, elapsed time in the event, never the condition.
		pinnedHandled := false
		if rev.unknown {
			// Inconclusive check: keep a prior PinnedRevisionNotFound verdict
			// verbatim (same static reason+message => status write is a no-op)
			// instead of flip-flopping to the generic reason on an API hiccup.
			// Without a prior verdict there is nothing to keep — fall through.
			prevReady := apimeta.FindStatusCondition(app.Status.Conditions, ConditionReady)
			if prevReady != nil && prevReady.Reason == ReasonPinnedRevisionNotFound {
				readyReason = ReasonPinnedRevisionNotFound
				readyMessage = prevReady.Message
				ksvcReason = ReasonPinnedRevisionNotFound
				ksvcMessage = prevReady.Message
				pinnedHandled = true
			}
		} else if elapsed, stalled := pinnedRevisionMissingStalled(rev.notFound, ksvc, now); stalled {
			readyReason = ReasonPinnedRevisionNotFound
			ksvcReason = ReasonPinnedRevisionNotFound
			readyMessage = fmt.Sprintf(
				"pinned revision %q does not exist in namespace %q — it may have been "+
					"garbage-collected, so the declared traffic pin can never resolve and Knative keeps "+
					"serving the last-good route. Run `kubectl get revisions -n %s` to list surviving "+
					"revisions, then re-pin via `kn-next rollback %s --to <existing-revision>` or clear "+
					"spec.traffic to return to latest-ready.",
				app.Spec.Traffic.RevisionName, app.Namespace, app.Namespace, app.Name)
			ksvcMessage = readyMessage
			prevReady := apimeta.FindStatusCondition(app.Status.Conditions, ConditionReady)
			if prevReady == nil || prevReady.Reason != ReasonPinnedRevisionNotFound {
				v.events = append(v.events, verdictEvent{corev1.EventTypeWarning, ReasonPinnedRevisionNotFound,
					fmt.Sprintf("%s (pin unresolved for %s)", readyMessage, elapsed.Round(time.Second))})
			}
			pinnedHandled = true
		}
		if elapsed, stalled := ingressProgrammingStalled(ksvc, now); !pinnedHandled && stalled {
			readyReason = ReasonIngressNotProgrammed
			ksvcReason = ReasonIngressNotProgrammed
			readyMessage = fmt.Sprintf(
				"route programming has stalled: the Knative Route's ingress (KIngress) has been "+
					"unreconciled for more than %s (%s). This usually means no ingress controller "+
					"serves the cluster's configured ingress-class — check the `ingress-class` key in "+
					"the config-network ConfigMap (knative-serving namespace); on Knative-Operator-managed "+
					"clusters the KnativeServing CR overwrites that ConfigMap, so fix the class in the CR. "+
					"net-kourier serves %q (NOT the short `kourier.knative.dev` form).",
				ingressProgrammingStallWindow, ksvcIngressNotConfiguredReason, kourierServedIngressClass)
			ksvcMessage = readyMessage
			prevReady := apimeta.FindStatusCondition(app.Status.Conditions, ConditionReady)
			if prevReady == nil || prevReady.Reason != ReasonIngressNotProgrammed {
				v.events = append(v.events, verdictEvent{corev1.EventTypeWarning, ReasonIngressNotProgrammed,
					fmt.Sprintf("%s (stalled for %s)", readyMessage, elapsed.Round(time.Second))})
			}
		}
		v.conditions = append(v.conditions, metav1.Condition{
			Type:               ConditionReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: app.Generation,
			Reason:             readyReason,
			Message:            readyMessage,
		})
		v.conditions = append(v.conditions, metav1.Condition{
			Type:               ConditionDegraded,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: app.Generation,
			Reason:             ksvcReason,
			Message:            ksvcMessage,
		})
		// Bounded requeue so status converges toward the ksvc's real health.
		v.requeueAfter = ksvcNotReadyRequeueAfter
	}

	// A ghost pin can momentarily coexist with a still-True ksvc Ready (Knative
	// hasn't processed the new spec.traffic yet). We deliberately don't degrade
	// in that window — pinnedRevisionMissingStalled waits for a non-True route
	// condition — but we must keep re-evaluating even if the Owns(ksvc) watch is
	// quiet, so the stall window is eventually judged.
	if rev.notFound && v.requeueAfter == 0 {
		v.requeueAfter = ksvcNotReadyRequeueAfter
	}

	// Non-fatal RevalidationDeferred condition: surface (but don't fail on) a kafka
	// revalidation request whose consumer hasn't been built yet (issue #95).
	//
	// Two reasons, because two different things are being reported. The plain
	// deferral says "kafka revalidation does nothing yet". The inert reason
	// additionally says "and the field you set to fix that was withdrawn" — the
	// message must NOT tell anyone to set provisionKafkaSource, which the operator
	// now ignores (#475); an operator that advises a value it then discards is the
	// same false-green this condition exists to prevent.
	if revalidationDeferred(app) {
		reason := "ConsumerNotProvisioned"
		message := "revalidation.queue=kafka requested but no KafkaSource was provisioned: " +
			"the {app}-revalidator consumer is design-now/build-later (#95), so ISR revalidation " +
			"over kafka is inert. Cache invalidation still works fleet-wide through the shared " +
			"Redis-backed cache; no action is available or needed here."
		if provisionKafkaSourceRequested(app) {
			reason = ReasonProvisionKafkaSourceInert
			message = "spec.revalidation.provisionKafkaSource=true is ignored: the bring-your-own " +
				"external-consumer path it opted into is withdrawn — the {app}-revalidator sink " +
				"contract was never specified or tested, so no KafkaSource is created (#475). The " +
				"field still applies and the rest of this app reconciles normally; remove it to " +
				"silence this. Kafka ISR revalidation returns when knext ships the consumer (ADR-0016)."
			// Transition-gated (the #98 no-op contract): fire only when the verdict
			// newly enters the inert state, never on every converged pass.
			prev := apimeta.FindStatusCondition(app.Status.Conditions, ConditionRevalidationDeferred)
			if prev == nil || prev.Reason != ReasonProvisionKafkaSourceInert {
				v.events = append(v.events, verdictEvent{
					corev1.EventTypeWarning, ReasonProvisionKafkaSourceInert, message,
				})
			}
		}
		v.conditions = append(v.conditions, metav1.Condition{
			Type:               ConditionRevalidationDeferred,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: app.Generation,
			Reason:             reason,
			Message:            message,
		})
	} else {
		v.conditions = append(v.conditions, metav1.Condition{
			Type:               ConditionRevalidationDeferred,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: app.Generation,
			Reason:             "NotDeferred",
			Message:            "Kafka revalidation not deferred",
		})
	}

	// ImageCacheReady (ADR-0037): non-fatal surface of the prewarm DaemonSet's
	// node coverage. When prewarm is enabled, report True once every targeted
	// node has the app image pulled+pinned (ready == desired, desired > 0),
	// else False/Pulling. When disabled, drop the condition — but only if it was
	// previously present, so a never-prewarmed app's removeConditions/order stays
	// byte-identical (the #98 no-op guard).
	//
	// #471 item 4 — a prewarm RECONCILE failure (typically missing DaemonSet
	// RBAC) is DEGRADING, not fatal. Reconcile no longer returns that error, so
	// this branch is the only place it becomes visible: the condition carries the
	// underlying message, a bounded requeue is the only retry, and a
	// transition-gated Warning event keeps it from being silent. Ready/Degraded
	// are deliberately untouched — an opt-in cold-start optimisation must not
	// make the app look unhealthy.
	prevImageCache := apimeta.FindStatusCondition(app.Status.Conditions, ConditionImageCacheReady)

	// A prewarm failure only deserves a VERDICT when there is something for the
	// verdict to be about: the feature is on, or we previously reported on it.
	//
	// This gate is load-bearing, not defensive. The delete issued when prewarm is
	// disabled is unconditional, so on the very upgrade path the amendment above
	// cites — an operator running without its new DaemonSet RBAC — a Forbidden
	// reaches here for EVERY NextApp in the cluster, including every app that
	// never opted in. Without the gate each of them grows a CleanupFailed
	// condition asserting a DaemonSet that never existed, a Warning, and a forced
	// 2-minute poll, which also breaks the byte-identical-conditions invariant the
	// disabled branch exists to protect (#98). The failure is NOT lost: it still
	// increments knext_nextapp_image_prewarm_errors_total and still fires the
	// KnextImagePrewarmFailing alert, which is where a cluster-wide RBAC problem
	// belongs — in the operator's own metrics, not smeared across every app's status.
	prewarmFailureIsReportable := ic.reconcileErrMsg != "" && (ic.enabled || prevImageCache != nil)

	// A lost optimistic-concurrency race is retried, never reported: it says
	// nothing about the DaemonSet's health, and degrading on it would flap the
	// condition (True -> False -> True) on routine write contention.
	if ic.transientErr && (ic.enabled || prevImageCache != nil) {
		if v.requeueAfter == 0 || v.requeueAfter > ksvcNotReadyRequeueAfter {
			v.requeueAfter = ksvcNotReadyRequeueAfter
		}
	}

	switch {
	case prewarmFailureIsReportable:
		reason := ReasonReconcileFailed
		what := "image prewarm DaemonSet could not be reconciled"
		if !ic.enabled {
			// Disabled but the leftover DaemonSet could not be deleted. Removing
			// the condition here would hide an orphaned DaemonSet still pinning
			// the image on every node.
			reason = ReasonCleanupFailed
			what = "image prewarm is disabled but its DaemonSet could not be deleted"
		}
		message := fmt.Sprintf("%s: %s", what, ic.reconcileErrMsg)
		if ic.enabled {
			// Coverage is still READ on the failure path, so report it: "nothing is
			// cached" and "9 of 10 nodes are cached and the 10th update was
			// rejected" are very different incidents, and dropping the numbers
			// discarded live, still-accurate data.
			message = fmt.Sprintf("%s (observed coverage: %d/%d node(s))", message, ic.ready, ic.desired)
		}
		v.conditions = append(v.conditions, metav1.Condition{
			Type:               ConditionImageCacheReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: app.Generation,
			Reason:             reason,
			Message:            message,
		})
		// Retried only by this requeue — never let it override a tighter one.
		if v.requeueAfter == 0 || v.requeueAfter > imagePrewarmFailureRequeueAfter {
			v.requeueAfter = imagePrewarmFailureRequeueAfter
		}
		// Transition-gated: fire once on entry, not on every requeue.
		if prevImageCache == nil || prevImageCache.Status != metav1.ConditionFalse ||
			prevImageCache.Reason != reason {
			v.events = append(v.events, verdictEvent{
				corev1.EventTypeWarning, ReasonImagePrewarmFailed, message,
			})
		}
	case ic.enabled:
		if ic.desired > 0 && ic.ready == ic.desired {
			v.conditions = append(v.conditions, metav1.Condition{
				Type:               ConditionImageCacheReady,
				Status:             metav1.ConditionTrue,
				ObservedGeneration: app.Generation,
				Reason:             "Cached",
				Message: fmt.Sprintf(
					"app image pulled and pinned on all %d prewarm node(s); scale-from-zero skips the image pull",
					ic.desired),
			})
		} else {
			v.conditions = append(v.conditions, metav1.Condition{
				Type:               ConditionImageCacheReady,
				Status:             metav1.ConditionFalse,
				ObservedGeneration: app.Generation,
				Reason:             "Pulling",
				Message: fmt.Sprintf(
					"image prewarm in progress: %d/%d prewarm node(s) have the app image pulled+pinned",
					ic.ready, ic.desired),
			})
		}
	case prevImageCache != nil:
		v.removeConditions = append(v.removeConditions, ConditionImageCacheReady)
	}

	// NetworkPolicyEnforced (#744): the operator reconciles a default-on
	// NetworkPolicy, but enforcement is the CNI's job — flannel (OKE GA,
	// OrbStack) ships no policy controller, so there the policy is declarative
	// only, and until this condition NOTHING said so at runtime. Report the
	// detection outcome honestly: True only on a detected policy controller,
	// False when flannel alone is running, Unknown when we cannot tell —
	// "cannot determine" is a distinct outcome from "enforced", never folded
	// into it.
	//
	// Same churn discipline as every condition here: messages are STATIC for a
	// given cluster state (evidence is sorted upstream), and the Warning event
	// fires only on TRANSITION into the unenforced state (#98 no-op guard).
	// When the policy is disabled the condition is dropped — but only if it was
	// previously present, so a policy-off app's conditions order stays
	// byte-identical (the ImageCacheReady precedent).
	prevNetpol := apimeta.FindStatusCondition(app.Status.Conditions, ConditionNetworkPolicyEnforced)
	switch {
	case np.enabled:
		var cond metav1.Condition
		switch np.verdict {
		case netpolEnforcementEnforced:
			cond = metav1.Condition{
				Type:               ConditionNetworkPolicyEnforced,
				Status:             metav1.ConditionTrue,
				ObservedGeneration: app.Generation,
				Reason:             ReasonPolicyControllerDetected,
				Message: fmt.Sprintf(
					"a NetworkPolicy-enforcing agent is running (%s) — the reconciled NetworkPolicy is in force",
					np.evidence),
			}
		case netpolEnforcementLikelyUnenforced:
			cond = metav1.Condition{
				Type:               ConditionNetworkPolicyEnforced,
				Status:             metav1.ConditionFalse,
				ObservedGeneration: app.Generation,
				Reason:             ReasonNoPolicyController,
				Message: fmt.Sprintf(
					"flannel is the cluster CNI (%s) and no NetworkPolicy controller was detected: the "+
						"reconciled NetworkPolicy is declarative only — it is written but enforces NOTHING on "+
						"this cluster. Install a policy-capable CNI (Calico/Cilium) to make it effective, or "+
						"treat network isolation as absent.",
					np.evidence),
			}
			// Loud on entry: a security control believed in force but silently
			// inert is worse than a known-absent one.
			if prevNetpol == nil || prevNetpol.Reason != ReasonNoPolicyController {
				v.events = append(v.events, verdictEvent{
					corev1.EventTypeWarning, ReasonNoPolicyController, cond.Message,
				})
			}
		default:
			cond = metav1.Condition{
				Type:               ConditionNetworkPolicyEnforced,
				Status:             metav1.ConditionUnknown,
				ObservedGeneration: app.Generation,
				Reason:             ReasonEnforcementUnknown,
				Message: "cannot determine whether the cluster CNI enforces NetworkPolicy (no known CNI " +
					"DaemonSet signature found, or the DaemonSet read failed) — treat the reconciled " +
					"NetworkPolicy as unenforced until verified",
			}
		}
		v.conditions = append(v.conditions, cond)
	case prevNetpol != nil:
		v.removeConditions = append(v.removeConditions, ConditionNetworkPolicyEnforced)
	}

	return v
}
