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
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// deployState is the pure result of deriveDeployState: the scale-state +
// last-successful-deploy status fields surfaced on the NextApp CR (#312). It is
// computed only from the child Knative Service status the operator already
// reconciles (latest-ready revision + rolled-up Ready) plus the observed
// activeness of that revision — no replica-count bookkeeping is invented.
type deployState struct {
	// observedRevision mirrors ksvc.status.latestReadyRevisionName.
	observedRevision string
	// scaledToZero is true when the observed revision is Ready but Inactive, nil
	// when the revision's activeness is unknown (could not be read).
	scaledToZero *bool
	// lastSuccessfulDeployTime is the time the CURRENT observed revision first
	// reached Ready. It advances only on a NEW ready revision; a later failed
	// rollout leaves it at the last good deploy.
	lastSuccessfulDeployTime *metav1.Time
}

// deriveDeployState computes the #312 scale-state + last-deploy status from the
// child ksvc and the observed activeness of the latest-ready revision:
//
//   - observedRevision  <- ksvc.status.latestReadyRevisionName
//   - scaledToZero       <- revisionActive; nil (unknown) is preserved as nil,
//     false => scaled to zero (true), true => not scaled to zero (false)
//   - lastSuccessfulDeployTime advances to `now` only when the ksvc is Ready AND
//     the observed revision differs from the one already recorded in status;
//     otherwise the prior deploy time is preserved (a failing new rollout must
//     NOT clobber the last-good deploy timestamp).
//
// revisionActive carries the latest-ready Revision's Knative "Active" condition:
// true = active, false = inactive (scaled to zero), nil = unknown/not read.
func deriveDeployState(
	app *appsv1alpha1.NextApp,
	ksvc *servingv1.Service,
	revisionActive *bool,
	now time.Time,
) deployState {
	ds := deployState{
		observedRevision:         ksvc.Status.LatestReadyRevisionName,
		lastSuccessfulDeployTime: app.Status.LastSuccessfulDeployTime,
	}

	// scaledToZero == !active, but only when activeness is known.
	if revisionActive != nil {
		scaled := !*revisionActive
		ds.scaledToZero = &scaled
	}

	ksvcReady := ksvc.Status.GetCondition(servingv1.ServiceConditionReady).IsTrue()
	if ksvcReady && ds.observedRevision != "" {
		// Advance the last-successful-deploy time only when the ready revision is
		// new (or none was recorded yet). Preserving it on an unchanged revision
		// keeps the status write a no-op on the idle, converged object (#98).
		if app.Status.ObservedRevision != ds.observedRevision || app.Status.LastSuccessfulDeployTime == nil {
			ds.lastSuccessfulDeployTime = &metav1.Time{Time: now}
		}
	}

	return ds
}
