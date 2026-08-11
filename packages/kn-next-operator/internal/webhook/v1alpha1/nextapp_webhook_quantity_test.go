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
	"context"
	"testing"
	"time"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #635, AC "the rejection happens at admission, so such a CR is never stored".
//
// The CRD types every quantity field as a plain `string`, so the apiserver never
// parses it — MEASURED against envtest, a NextApp carrying
// spec.resources.cpuRequest="1e2147483648" is persisted verbatim when the webhook
// is not in the path. The webhook is therefore the ONLY thing standing between a
// hostile value and stored state, and it has to answer PROMPTLY: a webhook whose
// handler never returns is not a rejection, it is an apiserver timeout
// (10 s default) plus a wedged handler goroutine that never goes away.
const webhookQuantityBudget = time.Second

// pathologicalQuantities mirrors the operator-side list; the class is
// "resource.ParseQuantity does not return", not one magic string.
var pathologicalQuantities = []string{
	"1e2147483648",
	"1E2147483648",
	"1e+2147483648",
	"-1e2147483648",
	"1e-2147483648",
	"1e00000002147483648",
	"1e4000000000",
}

func admitWithin(t *testing.T, call func() error, budget time.Duration) (returned bool, err error) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- call() }()
	select {
	case err = <-done:
		return true, err
	case <-time.After(budget):
		return false, nil
	}
}

func TestAdmissionRejectsAbsurdExponentPromptly(t *testing.T) {
	v := &NextAppCustomValidator{}
	ctx := context.Background()

	for _, value := range pathologicalQuantities {
		for _, tc := range []struct {
			name string
			spec appsv1alpha1.NextAppSpec
		}{
			{"cpuRequest", appsv1alpha1.NextAppSpec{Image: digestImage, Resources: &appsv1alpha1.ResourcesSpec{CPURequest: value}}},
			{"memoryLimit", appsv1alpha1.NextAppSpec{Image: digestImage, Resources: &appsv1alpha1.ResourcesSpec{MemoryLimit: value}}},
		} {
			app := newNextApp(tc.spec)

			returned, err := admitWithin(t, func() error {
				_, e := v.ValidateCreate(ctx, app)
				return e
			}, webhookQuantityBudget)
			if !returned {
				t.Errorf("CREATE %s=%q: the webhook did not answer within %v — the apiserver would time "+
					"out and the handler goroutine is wedged", tc.name, value, webhookQuantityBudget)
			} else if err == nil {
				t.Errorf("CREATE %s=%q: admitted; the CR would be STORED and then wedge a reconcile worker",
					tc.name, value)
			}

			// UPDATE must reject it too: an in-place edit of a healthy app is the
			// other way the value reaches storage. The ratcheting that ADR-0019
			// applies to the env-collision rule deliberately does NOT extend here
			// — this value has never been reconcilable, so carrying it forward
			// buys nobody anything.
			old := newNextApp(appsv1alpha1.NextAppSpec{Image: digestImage})
			returned, err = admitWithin(t, func() error {
				_, e := v.ValidateUpdate(ctx, old, app)
				return e
			}, webhookQuantityBudget)
			if !returned {
				t.Errorf("UPDATE %s=%q: the webhook did not answer within %v", tc.name, value, webhookQuantityBudget)
			} else if err == nil {
				t.Errorf("UPDATE %s=%q: admitted; the CR would be STORED", tc.name, value)
			}
		}
	}
}

// TestAdmissionStillAdmitsLegitimateQuantities is the other half of the gate:
// the bound must not turn ordinary deploys into admission failures.
func TestAdmissionStillAdmitsLegitimateQuantities(t *testing.T) {
	v := &NextAppCustomValidator{}
	ctx := context.Background()
	for _, value := range []string{"250m", "1", "512Mi", "1Gi", "1e3", "1e9999"} {
		app := newNextApp(appsv1alpha1.NextAppSpec{
			Image:     digestImage,
			Resources: &appsv1alpha1.ResourcesSpec{CPURequest: value},
		})
		if _, err := v.ValidateCreate(ctx, app); err != nil {
			t.Errorf("CREATE cpuRequest=%q rejected: %v", value, err)
		}
	}
}
