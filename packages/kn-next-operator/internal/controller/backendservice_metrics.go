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

// Zone-function (BackendService) metrics. Labelled by result or reason, never
// per object.
//
// REGISTERED UNCONDITIONALLY, at top level in init(): the series exist (at 0)
// whether or not the BackendService CRD is installed and whether or not the
// controller runs, so an alert sees a real 0, never an absent series that
// reads as "fine". A registration under a condition would make the metric
// contract golden claim a family the binary does not always serve.
var (
	// backendServiceReconcileTotal counts BackendService reconcile loops by result.
	backendServiceReconcileTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "knext_backendservice_reconcile_total",
			Help: "Total number of BackendService (zone function) reconcile loops, labeled by result (success | error).",
		},
		[]string{"result"},
	)

	// backendServiceRefusalsTotal counts transitions INTO a refusal, by reason: a
	// function the operator would not render (zone missing, binding not
	// consented, an image other than the one the zone pinned, a conflicting owner, a credential-allowlist violation, an
	// unpinned image, a name another object controls), or would render only
	// without its zone's JWKS (a ConfigMap the zone does not control holds the
	// name).
	backendServiceRefusalsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "knext_backendservice_refusals_total",
			Help: "Total number of times a BackendService entered a refused state, labeled by reason " +
				"(ZoneNotFound | ZoneNotListed | BindingImageMismatch | ConflictingOwner | SovereigntyViolation | InvalidImage | KnativeServiceNameTaken | JWKSUntrusted).",
		},
		[]string{"reason"},
	)
)

// backendServiceRefusalReasons is every reason the refusals counter carries.
var backendServiceRefusalReasons = []string{
	ReasonZoneNotFound, ReasonZoneNotListed, ReasonBindingImageMismatch, ReasonConflictingOwner,
	ReasonSovereigntyViolation, ReasonInvalidImage, ReasonKnativeServiceNameTaken, ReasonJWKSUntrusted,
}

func init() {
	metrics.Registry.MustRegister(backendServiceReconcileTotal, backendServiceRefusalsTotal)
	for _, result := range []string{"success", "error"} {
		backendServiceReconcileTotal.WithLabelValues(result).Add(0)
	}
	for _, reason := range backendServiceRefusalReasons {
		backendServiceRefusalsTotal.WithLabelValues(reason).Add(0)
	}
}
