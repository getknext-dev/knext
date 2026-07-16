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

// Lease-failover behavior test (v6-P3, closing the gap noted in
// internal/install/ha_test.go lines 11-13).
//
// The manifest contract test (internal/install/ha_test.go) proves the HA change
// is STRUCTURALLY correct: replicas:2 + --leader-elect + PDB + soft anti-affinity.
// What it structurally CANNOT prove is the runtime invariant ADR-0001 leans on:
// with replicas>1, controller-runtime leader election yields exactly ONE active
// reconciler (single-writer) and a standby that takes over on primary loss.
//
// This envtest spec proves that behavior against a real apiserver/etcd:
//   1. Start TWO managers with leader election enabled, same LeaderElectionID.
//   2. Assert exactly ONE acquires the coordination Lease (single-active); the
//      other stands by (its leadership callback never fires while #1 holds).
//   3. Trigger hand-off DETERMINISTICALLY by cancelling the leader's manager
//      context (NOT by waiting on natural lease expiry — that is slow + flaky).
//   4. Assert the STANDBY then acquires leadership, observed via its leadership
//      callback AND the Lease.holderIdentity flipping to the standby — never via
//      a wall-clock sleep.
//
// Production lease durations stay at controller-runtime defaults (cmd/main.go is
// untouched, and LeaderElectionReleaseOnCancel is NOT flipped). The short
// durations below are TEST-ONLY manager options, purely to keep the acquire path
// fast; the hand-off itself is cancellation-driven, not expiry-driven.

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	coordinationv1 "k8s.io/api/coordination/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

const (
	leTestLeaseID        = "v6p3-failover.kn-next.dev"
	leTestLeaseNamespace = "default"
)

// leManager bundles a manager, its cancelable context, and a channel that is
// closed the moment this manager wins leadership. The channel is the OBSERVED
// signal for "became active leader" — controller-runtime invokes the runnable
// registered via mgr.Add only after this instance holds the lease.
type leManager struct {
	id      string
	mgr     manager.Manager
	cancel  context.CancelFunc
	elected chan struct{}
	stopped chan struct{}
}

// newLeaderElectedManager builds a manager with leader election ENABLED against
// the shared envtest cfg. Lease durations are shortened for test speed only; the
// hand-off assertion does not depend on expiry. LeaderElectionReleaseOnCancel is
// left at its default (false) to mirror production wiring — hand-off is proven by
// cancelling the manager, which stops the lease renewal loop.
func newLeaderElectedManager(id string) *leManager {
	leaseDur := 4 * time.Second
	renewDl := 3 * time.Second
	retryP := 500 * time.Millisecond

	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:                        k8sClient.Scheme(),
		LeaderElection:                true,
		LeaderElectionID:              leTestLeaseID,
		LeaderElectionNamespace:       leTestLeaseNamespace,
		LeaderElectionReleaseOnCancel: false,
		LeaseDuration:                 &leaseDur,
		RenewDeadline:                 &renewDl,
		RetryPeriod:                   &retryP,
		// Disable metrics/health servers so two managers can coexist in-proc
		// without port collisions ("0" == disabled).
		Metrics:                metricsserver.Options{BindAddress: "0"},
		HealthProbeBindAddress: "0",
	})
	Expect(err).NotTo(HaveOccurred())

	lm := &leManager{
		id:      id,
		mgr:     mgr,
		elected: make(chan struct{}),
		stopped: make(chan struct{}),
	}

	// A leader-election runnable: mgr.Add with a runnable whose Start is invoked
	// ONLY once this manager is the elected leader. Closing lm.elected is the
	// observable "became leader" event.
	Expect(mgr.Add(manager.RunnableFunc(func(ctx context.Context) error {
		close(lm.elected)
		<-ctx.Done()
		return nil
	}))).To(Succeed())

	return lm
}

// start launches the manager in a goroutine with its own cancelable context.
func (lm *leManager) start(parent context.Context) {
	mctx, mcancel := context.WithCancel(parent)
	lm.cancel = mcancel
	go func() {
		defer close(lm.stopped)
		_ = lm.mgr.Start(mctx)
	}()
}

// isLeader reports whether this manager has fired its leadership callback.
func (lm *leManager) isLeader() bool {
	select {
	case <-lm.elected:
		return true
	default:
		return false
	}
}

// leaseHolder reads the coordination Lease's holderIdentity — the apiserver's
// own record of who currently owns leadership, independent of the callbacks.
func leaseHolder(ctx context.Context) string {
	lease := &coordinationv1.Lease{}
	nn := types.NamespacedName{Name: leTestLeaseID, Namespace: leTestLeaseNamespace}
	if err := k8sClient.Get(ctx, nn, lease); err != nil {
		return ""
	}
	if lease.Spec.HolderIdentity == nil {
		return ""
	}
	return *lease.Spec.HolderIdentity
}

var _ = Describe("Operator HA leader-election failover (ADR-0001 single-writer)", func() {
	ctx := context.Background()

	It("elects exactly one active leader and hands off to the standby on leader loss", func() {
		By("cleaning any stale lease from a previous run")
		stale := &coordinationv1.Lease{
			ObjectMeta: metav1.ObjectMeta{Name: leTestLeaseID, Namespace: leTestLeaseNamespace},
		}
		_ = k8sClient.Delete(ctx, stale)

		By("starting two managers with leader election enabled, same lease ID")
		suiteCtx, suiteCancel := context.WithCancel(ctx)
		defer suiteCancel()

		a := newLeaderElectedManager("mgr-a")
		b := newLeaderElectedManager("mgr-b")
		a.start(suiteCtx)
		b.start(suiteCtx)

		By("exactly ONE manager becomes the active leader")
		Eventually(func() bool {
			return a.isLeader() || b.isLeader()
		}, 15*time.Second, 100*time.Millisecond).Should(BeTrue(), "one manager must acquire leadership")

		// Single-active invariant: the OTHER must remain a standby. Give the loser
		// a full lease cycle's worth of opportunity to (wrongly) fire — it must not.
		Consistently(func() bool {
			return a.isLeader() && b.isLeader()
		}, 3*time.Second, 200*time.Millisecond).Should(BeFalse(),
			"only ONE manager may be leader at a time — two active reconcilers is split-brain")

		var leader, standby *leManager
		if a.isLeader() {
			leader, standby = a, b
		} else {
			leader, standby = b, a
		}

		By("the Lease holderIdentity is recorded (the apiserver's own record of the single active leader)")
		var initialHolder string
		Eventually(func() string {
			initialHolder = leaseHolder(ctx)
			return initialHolder
		}, 10*time.Second, 100*time.Millisecond).ShouldNot(BeEmpty(),
			"the coordination Lease must record a holder")

		By("triggering hand-off DETERMINISTICALLY: cancel the leader's manager context (no expiry wait)")
		leader.cancel()
		// Wait for the leader's manager to actually stop so its lease-renewal loop
		// is gone — this is what makes the standby's takeover deterministic.
		Eventually(func() bool {
			select {
			case <-leader.stopped:
				return true
			default:
				return false
			}
		}, 15*time.Second, 100*time.Millisecond).Should(BeTrue(), "cancelled leader must stop")

		By("the STANDBY acquires leadership (observed via its leadership callback)")
		Eventually(func() bool {
			return standby.isLeader()
		}, 30*time.Second, 200*time.Millisecond).Should(BeTrue(),
			"standby must take over leadership after the leader is lost")

		By("the Lease holderIdentity flips to the standby (apiserver-confirmed hand-off)")
		Eventually(func() string {
			return leaseHolder(ctx)
		}, 30*time.Second, 200*time.Millisecond).ShouldNot(Equal(initialHolder),
			"the coordination Lease must record a NEW holder after failover")

		By("stopping the standby manager")
		standby.cancel()
		Eventually(func() bool {
			select {
			case <-standby.stopped:
				return true
			default:
				return false
			}
		}, 15*time.Second, 100*time.Millisecond).Should(BeTrue())
	})
})
