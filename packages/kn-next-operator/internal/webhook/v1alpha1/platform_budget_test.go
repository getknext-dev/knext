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
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The admission webhook must agree with the reconciler about the connection
// budget (ADR-0064): a platform that RAISES it must not be silently contradicted
// by a hardcoded 80 at `kubectl apply`, and one that LOWERS it must be honoured
// at write time too. The reconciler stays the authority — every read problem
// falls back to the built-in budget.

func platformReader(t *testing.T, mut func(*platformv1alpha1.KnextPlatformSpec), opts ...func(*fake.ClientBuilder)) client.Reader {
	t.Helper()
	s := runtime.NewScheme()
	if err := platformv1alpha1.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	b := fake.NewClientBuilder().WithScheme(s)
	if mut != nil {
		p := &platformv1alpha1.KnextPlatform{ObjectMeta: metav1.ObjectMeta{Name: platformv1alpha1.SingletonName}}
		mut(&p.Spec)
		b = b.WithObjects(p)
	}
	for _, o := range opts {
		o(b)
	}
	return b.Build()
}

func appWithWall(maxScale, poolMax int32) *appsv1alpha1.NextApp {
	return newNextApp(appsv1alpha1.NextAppSpec{
		Image:   digestImage,
		Scaling: &appsv1alpha1.ScalingSpec{MaxScale: maxScale, PoolMax: poolMax},
	})
}

func budgetOf(n int32) func(*platformv1alpha1.KnextPlatformSpec) {
	return func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: n}
	}
}

func TestAdmission_WithoutAPlatformReaderTheBuiltinBudgetApplies(t *testing.T) {
	v := &NextAppCustomValidator{} // the zero value: no platform layer
	ctx := context.Background()
	if _, err := v.ValidateCreate(ctx, appWithWall(8, 10)); err != nil {
		t.Errorf("8 x 10 = 80 is exactly the built-in budget, got %v", err)
	}
	if _, err := v.ValidateCreate(ctx, appWithWall(9, 9)); err == nil {
		t.Error("9 x 9 = 81 must be rejected by the built-in budget")
	}
}

func TestAdmission_APlatformCanRaiseOrLowerTheBudget(t *testing.T) {
	ctx := context.Background()

	raised := &NextAppCustomValidator{Platform: platformReader(t, budgetOf(160))}
	if _, err := raised.ValidateCreate(ctx, appWithWall(16, 10)); err != nil {
		t.Errorf("a platform budget of 160 must admit 16 x 10, got %v", err)
	}
	if _, err := raised.ValidateUpdate(ctx, appWithWall(16, 10), appWithWall(16, 10)); err != nil {
		t.Errorf("…and an update of it, got %v", err)
	}
	_, err := raised.ValidateCreate(ctx, appWithWall(17, 10))
	if err == nil {
		t.Fatal("17 x 10 = 170 exceeds even the raised budget")
	}
	if !strings.Contains(err.Error(), "160") || !strings.Contains(err.Error(), "connectionBudget") {
		t.Errorf("the error should name the platform's budget, got %q", err)
	}

	lowered := &NextAppCustomValidator{Platform: platformReader(t, budgetOf(40))}
	if _, err := lowered.ValidateCreate(ctx, appWithWall(4, 10)); err != nil {
		t.Errorf("4 x 10 = 40 fits a budget of 40, got %v", err)
	}
	if _, err := lowered.ValidateCreate(ctx, appWithWall(5, 10)); err == nil {
		t.Error("5 x 10 = 50 must be rejected at write time under a budget of 40")
	}
}

func TestAdmission_EveryPlatformReadProblemFallsBackToTheBuiltin(t *testing.T) {
	ctx := context.Background()
	over80 := appWithWall(16, 10) // 160: valid only under a raised budget

	for name, reader := range map[string]client.Reader{
		"no object":         platformReader(t, nil),
		"no database block": platformReader(t, func(s *platformv1alpha1.KnextPlatformSpec) { s.Profile = platformv1alpha1.ProfileDefault }),
		"zero budget":       platformReader(t, budgetOf(0)),
		"platform not valid": platformReader(t, func(s *platformv1alpha1.KnextPlatformSpec) {
			s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 160}
			s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: -5}
		}),
		"api error": platformReader(t, budgetOf(160), func(b *fake.ClientBuilder) {
			b.WithInterceptorFuncs(interceptor.Funcs{
				Get: func(context.Context, client.WithWatch, client.ObjectKey, client.Object, ...client.GetOption) error {
					return errors.New("boom")
				},
			})
		}),
	} {
		v := &NextAppCustomValidator{Platform: reader}
		if _, err := v.ValidateCreate(ctx, over80); err == nil {
			t.Errorf("%s: 160 connections must be rejected — the fallback is the built-in budget of 80", name)
		}
		if _, err := v.ValidateCreate(ctx, appWithWall(8, 10)); err != nil {
			t.Errorf("%s: 80 connections must still be admitted, got %v", name, err)
		}
	}
}
