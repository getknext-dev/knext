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
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// PodCreationBlocked: a namespace LimitRange or ResourceQuota rejects the pod
// the revision's ReplicaSet tries to create. The failure is otherwise visible
// only as a FailedCreate Event on the ReplicaSet — nothing on the NextApp.
//
// OBSERVATION: Knative already propagates the Deployment's ReplicaFailure
// condition (reason FailedCreate, message = the admission error) onto the
// Revision's ResourcesAvailable condition (serving.TransformDeploymentStatus →
// RevisionStatus.PropagateDeploymentStatus). Reading that is a durable status
// field, not an Event (which expire, are rate-limited and need cluster-wide
// events RBAC). The Revision GET is already granted, so this adds NO RBAC.
//
// SCOPE: only FailedCreate rejections whose message is a LimitRanger or quota
// admission error. Other FailedCreate causes (PSA, webhooks) and the rest of
// pod lifecycle are deliberately NOT mirrored — this is not a pod-events feed.

// ConditionPodCreationBlocked is True while the latest created revision's pods
// are being rejected at admission by a LimitRange or ResourceQuota. Absent
// otherwise. Warning-class: Ready/Degraded already reflect the ksvc.
const ConditionPodCreationBlocked = "PodCreationBlocked"

const (
	// ReasonLimitRangeRejected: a namespace LimitRange (max/min/ratio) rejected the pod.
	ReasonLimitRangeRejected = "LimitRangeRejected"
	// ReasonQuotaExceeded: a namespace ResourceQuota rejected the pod.
	ReasonQuotaExceeded = "QuotaExceeded"
)

// podCreationState carries the observation into computeStatusVerdict (which
// does no I/O). Zero value = not blocked.
type podCreationState struct {
	blocked  bool
	unknown  bool // read failed: keep the prior verdict rather than flip-flop
	reason   string
	revision string
	message  string
}

// classifyPodCreationBlock decides whether a revision's ResourcesAvailable
// condition is a LimitRange/quota admission rejection.
func classifyPodCreationBlock(rev *servingv1.Revision) (message, reason string, blocked bool) {
	cond := rev.Status.GetCondition(servingv1.RevisionConditionResourcesAvailable)
	if cond == nil || !cond.IsFalse() || cond.Reason != "FailedCreate" {
		return "", "", false
	}
	msg := cond.Message
	switch {
	case strings.Contains(msg, "exceeded quota"):
		return msg, ReasonQuotaExceeded, true
	case strings.Contains(msg, "usage per Container is"),
		strings.Contains(msg, "usage per Pod is"),
		strings.Contains(msg, "limit to request ratio"),
		strings.Contains(msg, "must be less than or equal to"),
		strings.Contains(msg, "LimitRange"):
		return msg, ReasonLimitRangeRejected, true
	}
	return "", "", false
}

// detectPodCreationBlocked reads the ksvc's latest CREATED revision (the one
// whose pods are being attempted — not necessarily Ready yet).
func (r *NextAppReconciler) detectPodCreationBlocked(ctx context.Context, app *appsv1alpha1.NextApp, ksvc *servingv1.Service) podCreationState {
	name := ksvc.Status.LatestCreatedRevisionName
	if name == "" {
		return podCreationState{}
	}
	rev := &servingv1.Revision{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: name}, rev); err != nil {
		if apierrors.IsNotFound(err) {
			return podCreationState{}
		}
		return podCreationState{unknown: true}
	}
	msg, reason, blocked := classifyPodCreationBlock(rev)
	if !blocked {
		return podCreationState{}
	}
	return podCreationState{blocked: true, reason: reason, revision: name, message: msg}
}
