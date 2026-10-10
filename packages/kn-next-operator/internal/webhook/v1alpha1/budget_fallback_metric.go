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

package v1alpha1

import (
	"github.com/prometheus/client_golang/prometheus"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

// Reasons the admission webhook fell back to the built-in connection budget
// although a platform layer is installed. These are the ABNORMAL paths only: a
// cluster with no KnextPlatform, or a platform that sets no budget, uses the
// built-in budget by design and is not counted.
const (
	// fallbackReadError: the KnextPlatform could not be read (API error,
	// timeout). The webhook admits against the built-in budget instead.
	fallbackReadError = "read_error"
	// fallbackPlatformInvalid: the KnextPlatform exists but fails validation, so
	// its budget is not trusted.
	fallbackPlatformInvalid = "platform_invalid"
)

// budgetFallbackTotal counts admissions that silently ignored the platform's
// connection budget. The fallback is deliberate (the reconciler is the
// authority), but it is invisible to the user who applied the change, so it has
// to be visible to the operator. Labelled by reason only, never per object.
var budgetFallbackTotal = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "knext_webhook_budget_fallback_total",
		Help: "Total number of NextApp admissions that fell back to the built-in connection budget " +
			"because the platform's budget could not be used, labeled by reason " +
			"(read_error | platform_invalid).",
	},
	[]string{"reason"},
)

func init() {
	// The webhook runs in the operator process, so this lands on the same
	// /metrics endpoint as the controller's series.
	metrics.Registry.MustRegister(budgetFallbackTotal)
	for _, reason := range []string{fallbackReadError, fallbackPlatformInvalid} {
		budgetFallbackTotal.WithLabelValues(reason).Add(0)
	}
}
