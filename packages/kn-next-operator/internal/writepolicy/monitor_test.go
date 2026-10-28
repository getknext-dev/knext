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

package writepolicy

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"github.com/go-logr/logr/funcr"
	dto "github.com/prometheus/client_model/go"
	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
)

// fakeSource serves the fixture's objects, with each part replaceable per test.
type fakeSource struct {
	mu                            sync.Mutex
	policy                        *admissionregistrationv1.ValidatingAdmissionPolicy
	binding                       *admissionregistrationv1.ValidatingAdmissionPolicyBinding
	username                      string
	policyErr, bindingErr, whoErr error
	calls                         int
}

func (s *fakeSource) Policy(context.Context, string) (*admissionregistrationv1.ValidatingAdmissionPolicy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	return s.policy, s.policyErr
}

func (s *fakeSource) Binding(context.Context, string) (*admissionregistrationv1.ValidatingAdmissionPolicyBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.binding, s.bindingErr
}

func (s *fakeSource) OperatorUsername(context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.username, s.whoErr
}

func (s *fakeSource) set(f func(*fakeSource)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(s)
}

func healthySource(t *testing.T) *fakeSource {
	t.Helper()
	f := loadVerdictFixture(t)
	p, b, username := objectsFor(t, f, verdictCase{Name: "healthy"})
	return &fakeSource{policy: p, binding: b, username: username}
}

func gaugeValue(t *testing.T) float64 {
	t.Helper()
	var m dto.Metric
	if err := enforcedGauge.Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetGauge().GetValue()
}

type logLines struct {
	mu    sync.Mutex
	lines []string
}

func (l *logLines) logger() logr.Logger {
	return funcr.New(func(prefix, args string) {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.lines = append(l.lines, prefix+" "+args)
	}, funcr.Options{})
}

func (l *logLines) warnings() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, s := range l.lines {
		if strings.Contains(s, "WARNING") {
			out = append(out, s)
		}
	}
	return out
}

func TestGaugeIsOneWhenThePolicyIsEnforced(t *testing.T) {
	src := healthySource(t)
	logs := &logLines{}
	m := &Monitor{Source: src, Name: "kn-next-operator-secret-configmap-writes", Log: logs.logger()}
	if v := m.CheckOnce(context.Background()); !v.Enforced {
		t.Fatalf("want enforced, got %+v", v)
	}
	if got := gaugeValue(t); got != 1 {
		t.Fatalf("gauge = %v, want 1", got)
	}
	if w := logs.warnings(); len(w) != 0 {
		t.Fatalf("an enforced policy must log no warning, got %v", w)
	}
}

func TestGaugeIsZeroAndOneWarningIsLoggedWhenNotEnforced(t *testing.T) {
	for _, tc := range []struct {
		name string
		mut  func(*fakeSource)
		want Reason
	}{
		{"policy deleted", func(s *fakeSource) { s.policy = nil }, ReasonPolicyMissing},
		{"binding deleted", func(s *fakeSource) { s.binding = nil }, ReasonBindingMissing},
		{"username mismatch", func(s *fakeSource) { s.username = "system:serviceaccount:elsewhere:op" }, ReasonIdentityMismatch},
		{"binding audits only", func(s *fakeSource) {
			s.binding.Spec.ValidationActions = []admissionregistrationv1.ValidationAction{admissionregistrationv1.Audit}
		}, ReasonBindingNotDeny},
		{"the identity lookup fails", func(s *fakeSource) { s.whoErr = errors.New("selfsubjectreviews is forbidden") }, ReasonUnverifiable},
		{"the policy read fails", func(s *fakeSource) { s.policyErr = errors.New("connection refused") }, ReasonUnverifiable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := healthySource(t)
			src.set(tc.mut)
			logs := &logLines{}
			m := &Monitor{Source: src, Name: "kn-next-operator-secret-configmap-writes", Log: logs.logger()}
			// Repeated checks of the same broken state: one warning, not one per tick.
			var v Verdict
			for i := 0; i < 3; i++ {
				v = m.CheckOnce(context.Background())
			}
			if v.Enforced || v.Reason != tc.want {
				t.Fatalf("verdict = %+v, want not enforced with reason %s", v, tc.want)
			}
			if got := gaugeValue(t); got != 0 {
				t.Fatalf("gauge = %v, want 0", got)
			}
			if w := logs.warnings(); len(w) != 1 {
				t.Fatalf("want exactly one warning across three identical checks, got %d: %v", len(w), w)
			}
		})
	}
}

// A control that comes back is announced, and one that goes away again warns
// again: the log follows the state, not the clock.
func TestWarningFollowsTheStateAcrossRecoveryAndRegression(t *testing.T) {
	src := healthySource(t)
	logs := &logLines{}
	m := &Monitor{Source: src, Name: "n", Log: logs.logger()}
	ctx := context.Background()
	savedPolicy := src.policy

	m.CheckOnce(ctx)
	src.set(func(s *fakeSource) { s.policy = nil })
	m.CheckOnce(ctx)
	if gaugeValue(t) != 0 || len(logs.warnings()) != 1 {
		t.Fatalf("deleting the policy must drop the gauge to 0 and warn once (gauge %v, warnings %v)", gaugeValue(t), logs.warnings())
	}
	src.set(func(s *fakeSource) { s.policy = savedPolicy })
	m.CheckOnce(ctx)
	if gaugeValue(t) != 1 {
		t.Fatalf("restoring the policy must raise the gauge to 1, got %v", gaugeValue(t))
	}
	src.set(func(s *fakeSource) { s.policy = nil })
	m.CheckOnce(ctx)
	if len(logs.warnings()) != 2 {
		t.Fatalf("a second regression must warn again, got %v", logs.warnings())
	}
}

func TestMonitorRunsOnEveryReplicaAndRechecksOnAnInterval(t *testing.T) {
	src := healthySource(t)
	m := &Monitor{Source: src, Name: "n", Interval: 10 * time.Millisecond, Log: logr.Discard()}
	// The gauge describes the cluster, not leadership: a standby that never
	// leads must still report it.
	if m.NeedLeaderElection() {
		t.Fatal("the self-check must run on every replica, leader or not")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.Start(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		src.mu.Lock()
		n := src.calls
		src.mu.Unlock()
		if n >= 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the monitor checked %d times in 5s; a deletion after start-up would go unseen", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Start returned %v on cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Start did not return after the context was cancelled")
	}
}
