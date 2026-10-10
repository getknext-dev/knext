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

// Package v1alpha1 contains the validating admission webhook for the NextApp
// custom resource. It rejects invalid NextApps at write time, before the API
// server persists them — defense-in-depth on top of the reconciler's
// fail-closed validation. Webhook and reconciler share a single validation
// function (internal/validation.ValidateNextAppSpec) so they cannot drift.
package v1alpha1

import (
	"context"
	"fmt"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// nextAppLog is for logging in this package.
var nextAppLog = logf.Log.WithName("nextapp-webhook")

// SetupNextAppWebhookWithManager registers the validating webhook for the
// NextApp resource with the manager.
func SetupNextAppWebhookWithManager(mgr ctrl.Manager) error {
	v := &NextAppCustomValidator{}
	// The platform's connection budget is read at admission only when the
	// KnextPlatform CRD is installed; otherwise the webhook is exactly what it was
	// before the platform layer existed (ADR-0064 D3).
	installed, err := platformv1alpha1.CRDInstalled(mgr.GetRESTMapper())
	if err != nil {
		// Unknown is not absent: failing here is what keeps a discovery blip from
		// silently dropping the platform's budget from admission.
		return fmt.Errorf("nextapp webhook: %w", err)
	}
	if installed {
		v.Platform = mgr.GetAPIReader()
	}
	return ctrl.NewWebhookManagedBy(mgr, &appsv1alpha1.NextApp{}).
		WithValidator(v).
		Complete()
}

// +kubebuilder:webhook:path=/validate-apps-kn-next-dev-v1alpha1-nextapp,mutating=false,failurePolicy=fail,sideEffects=None,groups=apps.kn-next.dev,resources=nextapps,verbs=create;update,versions=v1alpha1,name=vnextapp-v1alpha1.kb.io,admissionReviewVersions=v1

// NextAppCustomValidator validates NextApp resources at admission time. It
// implements admission.Validator[*NextApp] and delegates to the shared
// validation.ValidateNextAppSpec so admission and reconcile cannot diverge.
type NextAppCustomValidator struct {
	// Platform reads the cluster-scoped KnextPlatform. nil means "no platform
	// layer": the built-in connection budget applies. It is an UNCACHED reader on
	// purpose — a single GET of one cluster-scoped object per admission, which
	// avoids starting a KnextPlatform informer in the webhook path.
	Platform client.Reader
}

var _ admission.Validator[*appsv1alpha1.NextApp] = &NextAppCustomValidator{}

// connectionBudget is the budget maxScale × poolMax is checked against: the
// platform's database.connectionBudget when one is set and valid, otherwise the
// built-in. Write-time and reconcile-time must agree, or a platform that raises
// the budget would be silently contradicted at `kubectl apply`.
//
// Any read problem — no CRD, no object, a transient API error, a platform that
// fails validation — falls back to the BUILT-IN budget. That is deliberate: the
// reconciler is the authority (it holds a last-good Service and reports
// EffectiveSpecInvalid), so the worst a fallback can do is admit an app the
// reconciler then holds, or reject one the user can simply retry.
func (v *NextAppCustomValidator) connectionBudget(ctx context.Context) int {
	if v.Platform == nil {
		return validation.MaxAppConnections
	}
	p := &platformv1alpha1.KnextPlatform{}
	if err := v.Platform.Get(ctx, client.ObjectKey{Name: platformv1alpha1.SingletonName}, p); err != nil {
		return validation.MaxAppConnections
	}
	if validation.ValidatePlatformSpec(&p.Spec) != nil || p.Spec.Database == nil || p.Spec.Database.ConnectionBudget <= 0 {
		return validation.MaxAppConnections
	}
	return int(p.Spec.Database.ConnectionBudget)
}

// ValidateCreate validates the spec when a NextApp is created.
// On CREATE the DATABASE_URL(_RO) collision rule (ADR-0019) applies
// unratcheted: a fresh CR may never define the same env var in both
// spec.database and spec.secrets.envMap.
func (v *NextAppCustomValidator) ValidateCreate(ctx context.Context, nextApp *appsv1alpha1.NextApp) (admission.Warnings, error) {
	nextAppLog.Info("Validating NextApp on create", "name", nextApp.GetName())
	return nil, validation.ValidateNextAppSpecCreateWithBudget(&nextApp.Spec, v.connectionBudget(ctx))
}

// ValidateUpdate validates the spec when a NextApp is updated. The collision
// rule is RATCHETED (ADR-0019): only a collision the update ADDS is rejected;
// a pre-existing one (a CR stored before the rules existed) may be carried
// forward, so unrelated updates — image bumps — never brick a running app.
// The reconciler resolves carried-forward collisions loudly (spec.database
// wins + a Warning event).
func (v *NextAppCustomValidator) ValidateUpdate(ctx context.Context, oldApp, newApp *appsv1alpha1.NextApp) (admission.Warnings, error) {
	nextAppLog.Info("Validating NextApp on update", "name", newApp.GetName())
	var oldSpec *appsv1alpha1.NextAppSpec
	if oldApp != nil {
		oldSpec = &oldApp.Spec
	}
	return nil, validation.ValidateNextAppSpecUpdateWithBudget(oldSpec, &newApp.Spec, v.connectionBudget(ctx))
}

// ValidateDelete is a no-op: deletes are always allowed.
func (v *NextAppCustomValidator) ValidateDelete(_ context.Context, _ *appsv1alpha1.NextApp) (admission.Warnings, error) {
	return nil, nil
}
