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
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	dto "github.com/prometheus/client_model/go"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #455 (follow-up to #435/#454): the BLAST-RADIUS property itself, end to end.
//
// #454 proved at unit level that a malformed spec.resources quantity no longer
// reaches resource.MustParse inside buildDesiredKsvc. What it did NOT prove is
// the property the HIGH severity was actually about, which only shows up with a
// real workqueue and a real controller: ONE stored-malformed NextApp must not
// take the SHARED reconcile loop — and therefore every OTHER NextApp on the
// cluster — down with it, and it must settle into the workqueue's rate-limited
// backoff rather than spinning in a tight requeue loop.
//
// This spec runs the PRODUCTION wiring (SetupWithManager on a real manager
// against envtest's apiserver), stores a malformed CR the way an upgrade would
// (the validating webhook is not installed in this suite, exactly like a CR that
// predates the #435 check), and asserts four things:
//
//  1. sibling survives — the VALID NextApp still gets its child ksvc and still
//     reaches Ready=True while the malformed one is failing on every retry;
//  2. no panic — controller_runtime_reconcile_panics_total does not move;
//  3. graceful, field-named failure — a Warning event naming the offending
//     field and the grammar, so an operator can fix it from `kubectl describe`;
//  4. rate-limited backoff — the malformed object keeps retrying (it is not
//     silently dropped) but at a handful of attempts per multi-second window,
//     not a hot loop.
//
// What the mutation runs actually showed, recorded so nobody over-reads this
// spec (all four legs were run against deliberately-broken trees):
//
//   - There are TWO layers, and the spec asserts the PROPERTY, not a layer.
//     Reconcile calls validation.ValidateNextAppSpec BEFORE buildDesiredKsvc, so
//     a malformed spec.resources quantity is rejected there first. Removing
//     validateResources alone keeps this spec green — the error-returning
//     ParseQuantity at the sizing site catches it instead, with the same
//     operator-visible outcome. Removing BOTH (no validateResources AND
//     MustParse back at the sizing site) turns LEG 2 red on the panic counter.
//     That is the defense-in-depth claim, measured.
//   - LEG 1 is NOT a claim that a panicking reconciler would take the sibling
//     down here: controller-runtime defaults Controller.RecoverPanic to true, so
//     even the double-mutated tree kept reconciling the sibling. The sibling leg
//     asserts the property end to end; the leg with teeth against a MustParse
//     regression is LEG 2.
var _ = Describe("Blast radius of a stored-malformed NextApp (#455)", func() {
	const (
		blastNamespace = "blast-radius"
		validImage     = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
		// Malformed on purpose: "0.5 CPU" is not a Kubernetes quantity (space +
		// unknown suffix). resource.MustParse would panic on it.
		malformedCPURequest = "0.5 CPU"
	)

	It("keeps a sibling NextApp reconciling and settles the bad one into backoff", func() {
		ctx := context.Background()

		By("creating an isolated namespace for the two apps")
		ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: blastNamespace}}
		if err := k8sClient.Create(ctx, ns); err != nil {
			Expect(err.Error()).To(ContainSubstring("already exists"))
		}

		badNN := types.NamespacedName{Name: "blastradius-malformed", Namespace: blastNamespace}
		goodNN := types.NamespacedName{Name: "blastradius-sibling", Namespace: blastNamespace}

		By("storing a MALFORMED NextApp (no webhook here — this is the stored-CR case)")
		bad := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: badNN.Name, Namespace: badNN.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:     validImage,
				Resources: &appsv1alpha1.ResourcesSpec{CPURequest: malformedCPURequest},
			},
		}
		Expect(k8sClient.Create(ctx, bad)).To(Succeed(),
			"a malformed quantity is a plain string in the CRD schema, so it CAN be stored")

		By("storing a VALID sibling NextApp in the same namespace")
		good := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: goodNN.Name, Namespace: goodNN.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:     validImage,
				Resources: &appsv1alpha1.ResourcesSpec{CPURequest: "250m", MemoryRequest: "512Mi"},
			},
		}
		Expect(k8sClient.Create(ctx, good)).To(Succeed())

		panicsBefore := ctrlReconcileCounter("controller_runtime_reconcile_panics_total", "")
		// Counted across ALL results, not just "error": that keeps LEG 4 able to
		// fail in BOTH directions — a hot requeue that returns a nil error still
		// shows up here, and an object that is silently DROPPED (no retry at all)
		// fails the lower bound.
		reconcilesBefore := ctrlReconcileCounter("controller_runtime_reconcile_total", "")
		retriesBefore := workqueueCounter("workqueue_retries_total")

		By("starting the REAL controller wiring (SetupWithManager) against envtest")
		mgrCtx, mgrCancel := context.WithCancel(ctx)
		mgrDone := make(chan struct{})
		mgrErr := make(chan error, 1)
		// Registered FIRST so it runs LAST (Ginkgo cleanup is LIFO): the object
		// deletions below must be reconciled by a manager that is still running.
		// The cleanup WAITS for Start to return — this manager shares one
		// apiserver with every other spec in the suite, and a still-draining
		// manager keeps reconciling (and finalizing) objects those specs own.
		DeferCleanup(func() {
			mgrCancel()
			Eventually(mgrDone, "30s").Should(BeClosed(),
				"the manager must fully stop before the next spec runs")
			select {
			case err := <-mgrErr:
				Expect(err).NotTo(HaveOccurred(), "manager.Start returned an error")
			default: // already drained by the fast-fail check below
			}
		})

		mgr, err := ctrl.NewManager(cfg, ctrl.Options{
			Scheme: k8sClient.Scheme(),
			// Namespace-scoped cache: LEG 4 counts reconciles, and a cluster-wide
			// cache makes those counts a function of what OTHER specs happen to
			// have left in the apiserver (measured: 14 reconciles for this spec
			// alone vs 99 in a full-suite run, from ~85 leftover NextApps the
			// manager picks up and finalizes). Scoping the cache makes both
			// bounds functions of this spec's own two objects.
			Cache: cache.Options{
				DefaultNamespaces: map[string]cache.Config{blastNamespace: {}},
			},
			Metrics:                metricsserver.Options{BindAddress: "0"},
			HealthProbeBindAddress: "0",
		})
		Expect(err).NotTo(HaveOccurred())
		Expect((&NextAppReconciler{
			Client:   mgr.GetClient(),
			Scheme:   mgr.GetScheme(),
			Recorder: mgr.GetEventRecorderFor("nextapp-controller"),
		}).SetupWithManager(mgr)).To(Succeed())

		go func() {
			defer close(mgrDone)
			mgrErr <- mgr.Start(mgrCtx)
		}()

		// Fail FAST on a Start that never gets going. Swallowing the Start error
		// makes a bad manager config surface as an unexplained 30s/60s Eventually
		// timeout further down, which reads as a product bug rather than a
		// harness bug.
		Consistently(func() error {
			select {
			case err := <-mgrErr:
				return fmt.Errorf("manager.Start returned before the spec ran: %v", err)
			default:
				return nil
			}
		}, "2s", "100ms").Should(Succeed())
		DeferCleanup(func() {
			for _, nn := range []types.NamespacedName{badNN, goodNN} {
				cur := &appsv1alpha1.NextApp{}
				if err := k8sClient.Get(ctx, nn, cur); err == nil {
					Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				}
			}
			// The malformed app fails BEFORE the ksvc build on the delete path too,
			// so give the finalizer removal a bounded window rather than blocking.
			Eventually(func() bool {
				for _, nn := range []types.NamespacedName{badNN, goodNN} {
					if k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}) == nil {
						return false
					}
				}
				return true
			}, "30s", "200ms").Should(BeTrue(), "both NextApps must finalize and disappear")
		})

		By("LEG 1 — the VALID sibling still gets its child Knative Service")
		goodKsvc := &servingv1.Service{}
		Eventually(func() error {
			return k8sClient.Get(ctx, goodNN, goodKsvc)
		}, "30s", "200ms").Should(Succeed(),
			"a malformed SIBLING must not stop this app's reconcile")

		By("stamping the sibling's ksvc Ready, as Knative Serving would")
		Eventually(func() error {
			cur := &servingv1.Service{}
			if err := k8sClient.Get(ctx, goodNN, cur); err != nil {
				return err
			}
			cur.Status.ObservedGeneration = cur.Generation
			cur.Status.SetConditions(apis.Conditions{
				{Type: servingv1.ServiceConditionReady, Status: corev1.ConditionTrue},
			})
			cur.Status.LatestReadyRevisionName = goodNN.Name + "-00001"
			return k8sClient.Status().Update(ctx, cur)
		}, "15s", "200ms").Should(Succeed())

		By("LEG 1 — the VALID sibling reaches Ready=True")
		Eventually(func() string {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, goodNN, cur); err != nil {
				return "get-failed: " + err.Error()
			}
			for _, c := range cur.Status.Conditions {
				if c.Type == ConditionReady {
					return string(c.Status)
				}
			}
			return "no-ready-condition"
		}, "60s", "250ms").Should(Equal("True"),
			"the valid app must converge to Ready while the malformed sibling keeps failing")

		By("the MALFORMED app never produces a child Knative Service")
		Consistently(func() bool {
			return k8sClient.Get(ctx, badNN, &servingv1.Service{}) != nil
		}, "3s", "250ms").Should(BeTrue(),
			"the reconcile must abort before writing a ksvc built from an unparseable quantity")

		By("LEG 2 — no reconcile PANIC (this is what MustParse-at-use would produce)")
		Expect(ctrlReconcileCounter("controller_runtime_reconcile_panics_total", "")-panicsBefore).
			To(BeZero(), "a malformed stored quantity must be an ERROR, never a panic")

		By("LEG 3 — the failure is a graceful, field-named event an operator can act on")
		Eventually(func() string {
			return warningEventMessages(ctx, badNN)
		}, "30s", "250ms").Should(And(
			ContainSubstring("spec.resources.cpuRequest"),
			ContainSubstring("not a valid Kubernetes quantity"),
		))

		By("LEG 4 — the malformed object settles into RATE-LIMITED backoff, not a hot loop")
		// Let the per-item exponential backoff climb past the sub-second band
		// before sampling; the workqueue's base delay is 5ms doubling per failure.
		time.Sleep(6 * time.Second)
		atSettle := ctrlReconcileCounter("controller_runtime_reconcile_total", "")

		// LOWER bound — the item is still WORKED, on the RATE-LIMITED path.
		// workqueue_retries_total counts AddRateLimited calls, so it moves only
		// when a failed reconcile is re-queued through the failure rate limiter.
		// A dropped item (return nil) never increments it, and neither does a
		// tight RequeueAfter loop (that is AddAfter, a different code path) — so
		// this bound fails in BOTH of the wrong-behaviour directions, without
		// depending on where in the exponential ramp the sample happens to land.
		// Measured, not guessed (cluster-wide cache and namespace-scoped alike):
		// 13 rate-limited retries on the real tree in this window vs 2–3
		// (incidental conflict retries) when the malformed object is dropped with
		// `return ctrl.Result{}, nil`. The bound sits between them.
		Expect(workqueueCounter("workqueue_retries_total")-retriesBefore).
			To(BeNumerically(">=", 8),
				"the bad object must keep being RE-QUEUED through the rate limiter — "+
					"a silently-dropped item is its own bug")

		const window = 5 * time.Second
		time.Sleep(window)
		afterWindow := ctrlReconcileCounter("controller_runtime_reconcile_total", "")
		// A tight requeue (RequeueAfter ~0) bypasses the failure rate limiter and
		// produces hundreds of attempts in this window; even a bucket-limited-only
		// loop produces ~10/s. Settled exponential backoff produces a couple, and
		// the converged sibling contributes nothing (GenerationChangedPredicate +
		// the #98 no-op-status guard keep an idle object out of the queue).
		AddReportEntry("nextapp reconciles",
			fmt.Sprintf("%.0f up to settle, %.0f in the %s window",
				atSettle-reconcilesBefore, afterWindow-atSettle, window))
		Expect(afterWindow-atSettle).To(BeNumerically("<=", 5),
			fmt.Sprintf("expected settled backoff, saw %.0f reconciles in %s",
				afterWindow-atSettle, window))

		By("LEG 1 (again) — the sibling is STILL Ready after the bad object's retries")
		cur := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, goodNN, cur)).To(Succeed())
		readyNow := ""
		for _, c := range cur.Status.Conditions {
			if c.Type == ConditionReady {
				readyNow = string(c.Status)
			}
		}
		Expect(readyNow).To(Equal("True"))
	})
})

// ctrlReconcileCounter reads a controller-runtime counter for the "nextapp"
// controller straight out of the process's metrics registry — the same series
// the operator exposes in production. result == "" means the metric carries no
// result label. A metric family that has never been observed reads as 0.
func ctrlReconcileCounter(name, result string) float64 {
	families, err := ctrlmetrics.Registry.Gather()
	Expect(err).NotTo(HaveOccurred())
	for _, mf := range families {
		if mf.GetName() != name {
			continue
		}
		var total float64
		for _, m := range mf.GetMetric() {
			if !metricHasLabel(m, "controller", "nextapp") {
				continue
			}
			if result != "" && !metricHasLabel(m, "result", result) {
				continue
			}
			total += m.GetCounter().GetValue()
		}
		return total
	}
	return 0
}

// workqueueCounter reads a controller-runtime workqueue counter for the
// "nextapp" controller's queue. The workqueue metrics carry the queue name on a
// label whose KEY has moved between controller-runtime releases ("name",
// "controller"), so this matches on the VALUE across every label rather than
// hard-coding a key that a bump could silently invalidate.
func workqueueCounter(name string) float64 {
	families, err := ctrlmetrics.Registry.Gather()
	Expect(err).NotTo(HaveOccurred())
	for _, mf := range families {
		if mf.GetName() != name {
			continue
		}
		var total float64
		for _, m := range mf.GetMetric() {
			for _, l := range m.GetLabel() {
				if l.GetValue() == "nextapp" {
					total += m.GetCounter().GetValue()
					break
				}
			}
		}
		return total
	}
	return 0
}

func metricHasLabel(m *dto.Metric, name, value string) bool {
	for _, l := range m.GetLabel() {
		if l.GetName() == name && l.GetValue() == value {
			return true
		}
	}
	return false
}

// warningEventMessages concatenates the Warning-event messages recorded against
// one NextApp, so the assertion reads the operator-visible surface
// (`kubectl describe nextapp`) rather than a Go error value.
func warningEventMessages(ctx context.Context, nn types.NamespacedName) string {
	events := &corev1.EventList{}
	if err := k8sClient.List(ctx, events, client.InNamespace(nn.Namespace)); err != nil {
		return ""
	}
	var b strings.Builder
	for i := range events.Items {
		e := events.Items[i]
		if e.InvolvedObject.Name != nn.Name || e.InvolvedObject.Kind != "NextApp" {
			continue
		}
		if e.Type != corev1.EventTypeWarning {
			continue
		}
		b.WriteString(e.Message)
		b.WriteString("\n")
	}
	return b.String()
}
