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
	"time"

	"github.com/go-logr/logr"
	"github.com/prometheus/client_golang/prometheus"
	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

// DefaultInterval is how often the live objects are read again. A policy
// deleted after start-up is the case a one-shot check would miss; a get on two
// named objects every few minutes costs the apiserver nothing.
const DefaultInterval = 5 * time.Minute

// enforcedGauge is 1 when the operator's Secret/ConfigMap write policy is in
// force for this operator and 0 otherwise. 0 also covers "could not verify":
// the control is only reported as on when it was seen to be. Unlabeled by
// design (one operator, one policy), so the series cannot multiply.
var enforcedGauge = prometheus.NewGauge(prometheus.GaugeOpts{
	Name: "knext_operator_write_policy_enforced",
	Help: "1 when the ValidatingAdmissionPolicy that limits the operator's Secret and ConfigMap writes " +
		"exists, is bound with Deny, and names the identity the operator runs as; 0 when it is off or " +
		"could not be verified (the operator is then unrestricted).",
})

func init() {
	metrics.Registry.MustRegister(enforcedGauge)
}

// Source reads the objects the verdict needs. Policy and Binding return a nil
// object and a nil error when it does not exist.
type Source interface {
	Policy(ctx context.Context, name string) (*admissionregistrationv1.ValidatingAdmissionPolicy, error)
	Binding(ctx context.Context, name string) (*admissionregistrationv1.ValidatingAdmissionPolicyBinding, error)
	// OperatorUsername is the username the apiserver sees for this process.
	OperatorUsername(ctx context.Context) (string, error)
}

// Check reads the policy, its binding and the operator's own identity from src
// and decides. A read that fails is Unverifiable, which is not enforced.
func Check(ctx context.Context, src Source, name string) Verdict {
	username, err := src.OperatorUsername(ctx)
	if err != nil {
		return no(ReasonUnverifiable, "the operator could not look up its own identity: %v", err)
	}
	policy, err := src.Policy(ctx, name)
	if err != nil {
		return no(ReasonUnverifiable, "reading ValidatingAdmissionPolicy %q failed: %v", name, err)
	}
	binding, err := src.Binding(ctx, name)
	if err != nil {
		return no(ReasonUnverifiable, "reading ValidatingAdmissionPolicyBinding %q failed: %v", name, err)
	}
	return Evaluate(policy, binding, username)
}

// Monitor is a manager Runnable that keeps the gauge current. It runs on every
// replica, leader or not: the gauge describes the cluster, and a standby that
// reported nothing would leave a gap in the alert.
type Monitor struct {
	Source   Source
	Name     string
	Interval time.Duration
	Log      logr.Logger

	last *Verdict
}

// NeedLeaderElection is false: see Monitor.
func (m *Monitor) NeedLeaderElection() bool { return false }

// CheckOnce runs one check, publishes the gauge and logs a change.
func (m *Monitor) CheckOnce(ctx context.Context) Verdict {
	v := Check(ctx, m.Source, m.Name)
	if v.Enforced {
		enforcedGauge.Set(1)
	} else {
		enforcedGauge.Set(0)
	}
	changed := m.last == nil || m.last.Enforced != v.Enforced || m.last.Reason != v.Reason
	m.last = &v
	switch {
	case !changed:
	case v.Enforced:
		m.Log.Info("the operator write policy is in force", "policy", m.Name)
	default:
		// One line per change, not per check: a policy that stays off is already
		// on the gauge and the alert.
		m.Log.Info("WARNING: the operator write policy is NOT in force; the operator can write any Secret or ConfigMap "+
			"its RBAC allows", "policy", m.Name, "reason", string(v.Reason), "detail", v.Detail)
	}
	return v
}

// Start checks immediately, then every Interval until ctx is cancelled. It
// returns nil on cancellation and never an error for a failed check: not
// starting because a security control is off is a decision for the operator's
// owner, not for this monitor.
func (m *Monitor) Start(ctx context.Context) error {
	interval := m.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	m.CheckOnce(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			m.CheckOnce(ctx)
		}
	}
}
