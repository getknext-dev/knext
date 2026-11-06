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
	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ConditionNetworkPolicyDisabled is True while spec.security.networkPolicy is
// explicitly false on a NextApp or a BackendService: the operator reconciles no
// NetworkPolicy for it and removes the one it created, so the pods lose their
// pod-level isolation. It is a Warning-class condition: Ready is deliberately
// untouched, because the workload is healthy; the problem is lost isolation. It
// is absent whenever the policy is on (the default), and removed only if it was
// previously reported, so an object that never opted out keeps its persisted
// conditions byte-identical (#98). Status-only: no spec/schema change.
const ConditionNetworkPolicyDisabled = "NetworkPolicyDisabled"

// ReasonNetworkPolicyOptedOut is the reason (and Warning Event reason) for
// ConditionNetworkPolicyDisabled.
const ReasonNetworkPolicyOptedOut = "NetworkPolicyOptedOut"

// networkPolicyOptOutCondition is the opt-out warning for subject ("the app",
// "the function"). The message is static for a given subject, so a converged
// object's status write is a no-op (#98).
func networkPolicyOptOutCondition(subject string, generation int64) metav1.Condition {
	return metav1.Condition{
		Type:               ConditionNetworkPolicyDisabled,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: generation,
		Reason:             ReasonNetworkPolicyOptedOut,
		Message: "spec.security.networkPolicy is false: the operator does not reconcile a NetworkPolicy for " +
			subject + " and removes the one it created, so its pods have no pod-level network isolation " +
			"and accept traffic from any pod the network allows. Leave the field unset unless the cluster " +
			"ingress is not Kourier and the CNI enforces NetworkPolicy.",
	}
}

// networkPolicyOptOutVerdict decides the opt-out warning for one object: the
// condition to set (nil when the policy is on), whether the previously reported
// condition must now be dropped, and the Warning event, which fires on ENTRY
// only (#98 no-op guard). Shared by both kinds so they cannot drift.
func networkPolicyOptOutVerdict(
	optedOut bool, subject string, generation int64, conditions []metav1.Condition,
) (cond *metav1.Condition, remove bool, event *verdictEvent) {
	prev := apimeta.FindStatusCondition(conditions, ConditionNetworkPolicyDisabled)
	if !optedOut {
		return nil, prev != nil, nil
	}
	c := networkPolicyOptOutCondition(subject, generation)
	if prev == nil || prev.Status != c.Status || prev.Reason != c.Reason || prev.Message != c.Message {
		event = &verdictEvent{corev1.EventTypeWarning, ReasonNetworkPolicyOptedOut, c.Message}
	}
	return &c, false, event
}
