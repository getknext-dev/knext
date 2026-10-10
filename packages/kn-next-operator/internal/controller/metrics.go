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
	"github.com/prometheus/client_golang/prometheus"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

// knext-specific controller metrics. Cardinality is kept low on purpose: we label
// only by reconcile result/reason, never by per-object name, to avoid metric explosion.
var (
	// reconcileTotal counts NextApp reconcile loops by result ("success" | "error").
	reconcileTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "knext_nextapp_reconcile_total",
			Help: "Total number of NextApp reconcile loops, labeled by result.",
		},
		[]string{"result"},
	)

	// reconcileDuration observes the wall-clock duration of a reconcile loop.
	reconcileDuration = prometheus.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "knext_nextapp_reconcile_duration_seconds",
			Help:    "Duration of NextApp reconcile loops in seconds.",
			Buckets: prometheus.DefBuckets,
		},
	)

	// reconcileErrors counts reconcile loops that returned an error.
	reconcileErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "knext_nextapp_reconcile_errors_total",
			Help: "Total number of NextApp reconcile loops that ended in error.",
		},
	)

	// imagePrewarmErrors counts FAILED image-prewarm DaemonSet reconciles
	// (create/update, or the delete issued when the feature is turned off).
	//
	// WHY IT EXISTS (#471 item 4): the prewarm failure is deliberately NOT
	// returned out of Reconcile any more, so it no longer increments
	// reconcileErrors and no longer fires the critical KnextOperatorReconcileErrors
	// page — correct, because the app itself is healthy. But that removed the
	// ONLY alerting surface: what remained was a transition-gated Warning event
	// (which expires with event TTL) and an ImageCacheReady condition nothing
	// scrapes. This counter is what the (warning-severity) KnextImagePrewarmFailing
	// alert keys on, so the decoupling trades a false-critical for a visible
	// warning rather than for a silent failure.
	//
	// Unlabeled, matching the low-cardinality rule above: never per-object.
	imagePrewarmErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "knext_nextapp_image_prewarm_errors_total",
			Help: "Total number of failed image-prewarm DaemonSet reconciles. These do NOT fail " +
				"the NextApp reconcile pass (the app stays Ready); they degrade ImageCacheReady.",
		},
	)

	// --- Platform layer (ADR-0064) ------------------------------------------
	//
	// A held app is the platform layer's loudest silent failure: its live Knative
	// Service keeps serving the old revision while a change is not applied. The
	// status already says so per app (PlatformDefaultsApplied); these series are
	// the FLEET view, so an alert can fire without listing every NextApp. They
	// only OBSERVE decisions computeStatusVerdict and the limiter already made.
	// Labelled by hold reason, never per object.

	// platformHeldApps is how many apps are held RIGHT NOW, by hold reason
	// (EffectiveSpecInvalid | RolloutPending).
	platformHeldApps = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "knext_nextapp_platform_held_apps",
			Help: "Number of NextApps whose Knative Service is held unchanged by the platform layer, " +
				"labeled by reason (EffectiveSpecInvalid | RolloutPending).",
		},
		[]string{"reason"},
	)

	// platformHoldsTotal counts transitions INTO a hold, by reason. A hold that
	// persists across many passes is one hold, so rate() reads as "how often is
	// the platform holding apps", not as reconcile frequency.
	platformHoldsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "knext_nextapp_platform_holds_total",
			Help: "Total number of times a NextApp entered a platform hold, labeled by reason " +
				"(EffectiveSpecInvalid | RolloutPending).",
		},
		[]string{"reason"},
	)

	// rolloutQueueDepth is the rollout limiter's backlog: re-renders holding a
	// reservation behind rollout.maxAppsPerMinute. In-memory like the limiter
	// itself, so it resets to 0 on an operator restart or leader failover.
	rolloutQueueDepth = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "knext_platform_rollout_queue_depth",
			Help: "Platform-triggered re-renders currently queued behind rollout.maxAppsPerMinute.",
		},
	)

	// rolloutWaitSeconds observes how long a queued re-render was told to wait
	// for its slot. Only queued re-renders are observed: a pass that goes
	// straight through has no wait.
	rolloutWaitSeconds = prometheus.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "knext_platform_rollout_wait_seconds",
			Help:    "Seconds a platform-triggered re-render was told to wait for its rollout slot.",
			Buckets: []float64{1, 5, 15, 30, 60, 120, 300, 600},
		},
	)
)

func init() {
	// Register with controller-runtime's global registry so the series are served on
	// the existing /metrics endpoint alongside the built-in controller metrics.
	metrics.Registry.MustRegister(reconcileTotal, reconcileDuration, reconcileErrors, imagePrewarmErrors,
		platformHeldApps, platformHoldsTotal, rolloutQueueDepth, rolloutWaitSeconds)

	// Publish every series at 0 up front, so an alert on a held app sees a real
	// 0 rather than an absent series before the first hold ever happens.
	for _, reason := range []string{ReasonEffectiveSpecInvalid, ReasonRolloutPending} {
		platformHeldApps.WithLabelValues(reason).Set(0)
		platformHoldsTotal.WithLabelValues(reason).Add(0)
	}
	rolloutQueueDepth.Set(0)
}
