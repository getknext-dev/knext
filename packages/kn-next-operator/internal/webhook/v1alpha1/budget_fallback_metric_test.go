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
	"errors"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
)

// The webhook deliberately falls back to the built-in budget on a platform read
// problem (the reconciler is the authority). That fallback is silent to the user,
// so it is counted: an operator whose webhook has quietly stopped honouring the
// platform's budget must be visible on /metrics.

func fallbackCount(cause string) float64 {
	return testutil.ToFloat64(budgetFallbackTotal.WithLabelValues(cause))
}

func TestBudgetFallbackMetric_CountsAPIReadErrors(t *testing.T) {
	before := fallbackCount(fallbackReadError)
	v := &NextAppCustomValidator{Platform: platformReader(t, budgetOf(160), func(b *fake.ClientBuilder) {
		b.WithInterceptorFuncs(interceptor.Funcs{
			Get: func(context.Context, client.WithWatch, client.ObjectKey, client.Object, ...client.GetOption) error {
				return errors.New("boom")
			},
		})
	})}
	if got := v.connectionBudget(context.Background()); got != 80 {
		t.Fatalf("a read error must fall back to the built-in budget of 80, got %d", got)
	}
	if got := fallbackCount(fallbackReadError) - before; got != 1 {
		t.Errorf("a platform read error must count exactly one read_error fallback, got +%v", got)
	}
}

func TestBudgetFallbackMetric_CountsAPlatformThatFailsValidation(t *testing.T) {
	before := fallbackCount(fallbackPlatformInvalid)
	v := &NextAppCustomValidator{Platform: platformReader(t, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 160}
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: -5}
	})}
	if got := v.connectionBudget(context.Background()); got != 80 {
		t.Fatalf("an invalid platform must fall back to the built-in budget of 80, got %d", got)
	}
	if got := fallbackCount(fallbackPlatformInvalid) - before; got != 1 {
		t.Errorf("an invalid platform must count exactly one platform_invalid fallback, got +%v", got)
	}
}

// The normal paths are NOT fallbacks. A cluster with no KnextPlatform uses the
// built-in budget on every admission; counting that would make the series a
// constant and any alert on it meaningless.
func TestBudgetFallbackMetric_NormalPathsAreNotCounted(t *testing.T) {
	for name, reader := range map[string]client.Reader{
		"no platform reader": nil,
		"no object":          platformReader(t, nil),
		"no database block":  platformReader(t, func(s *platformv1alpha1.KnextPlatformSpec) { s.Profile = platformv1alpha1.ProfileDefault }),
		"budget unset":       platformReader(t, budgetOf(0)),
		"budget honoured":    platformReader(t, budgetOf(160)),
	} {
		beforeRead, beforeInvalid := fallbackCount(fallbackReadError), fallbackCount(fallbackPlatformInvalid)
		v := &NextAppCustomValidator{Platform: reader}
		v.connectionBudget(context.Background())
		if fallbackCount(fallbackReadError) != beforeRead || fallbackCount(fallbackPlatformInvalid) != beforeInvalid {
			t.Errorf("%s: a normal budget resolution must not count as a fallback", name)
		}
	}
}
