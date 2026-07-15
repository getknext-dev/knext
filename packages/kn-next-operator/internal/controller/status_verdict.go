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
// provision a KafkaSource because the `{app}-revalidator` consumer is not yet
// built (issue #95) and opt-in (spec.revalidation.provisionKafkaSource) is off.
func revalidationDeferred(app *appsv1alpha1.NextApp) bool {
	return app.Spec.Revalidation != nil && app.Spec.Revalidation.Queue == "kafka" &&
		!ptr.Deref(app.Spec.Revalidation.ProvisionKafkaSource, false)
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
	// revalidation request whose consumer hasn't been provisioned yet (issue #95).
	if revalidationDeferred(app) {
		v.conditions = append(v.conditions, metav1.Condition{
			Type:               ConditionRevalidationDeferred,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: app.Generation,
			Reason:             "ConsumerNotProvisioned",
			Message: "revalidation.queue=kafka requested but no KafkaSource was provisioned: " +
				"the {app}-revalidator consumer is design-now/build-later (#95). Set " +
				"spec.revalidation.provisionKafkaSource=true once you deploy an external consumer.",
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

	return v
}
