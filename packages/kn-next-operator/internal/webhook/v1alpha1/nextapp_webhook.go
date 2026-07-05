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

	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// nextAppLog is for logging in this package.
var nextAppLog = logf.Log.WithName("nextapp-webhook")

// SetupNextAppWebhookWithManager registers the validating webhook for the
// NextApp resource with the manager.
func SetupNextAppWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, &appsv1alpha1.NextApp{}).
		WithValidator(&NextAppCustomValidator{}).
		Complete()
}

// +kubebuilder:webhook:path=/validate-apps-kn-next-dev-v1alpha1-nextapp,mutating=false,failurePolicy=fail,sideEffects=None,groups=apps.kn-next.dev,resources=nextapps,verbs=create;update,versions=v1alpha1,name=vnextapp-v1alpha1.kb.io,admissionReviewVersions=v1

// NextAppCustomValidator validates NextApp resources at admission time. It
// implements admission.Validator[*NextApp] and delegates to the shared
// validation.ValidateNextAppSpec so admission and reconcile cannot diverge.
type NextAppCustomValidator struct{}

var _ admission.Validator[*appsv1alpha1.NextApp] = &NextAppCustomValidator{}

// ValidateCreate validates the spec when a NextApp is created.
// On CREATE the DATABASE_URL(_RO) collision rule (ADR-0019) applies
// unratcheted: a fresh CR may never define the same env var in both
// spec.database and spec.secrets.envMap.
func (v *NextAppCustomValidator) ValidateCreate(_ context.Context, nextApp *appsv1alpha1.NextApp) (admission.Warnings, error) {
	nextAppLog.Info("Validating NextApp on create", "name", nextApp.GetName())
	return nil, validation.ValidateNextAppSpecCreate(&nextApp.Spec)
}

// ValidateUpdate validates the spec when a NextApp is updated. The collision
// rule is RATCHETED (ADR-0019): only a collision the update ADDS is rejected;
// a pre-existing one (a CR stored before the rules existed) may be carried
// forward, so unrelated updates — image bumps — never brick a running app.
// The reconciler resolves carried-forward collisions loudly (spec.database
// wins + a Warning event).
func (v *NextAppCustomValidator) ValidateUpdate(_ context.Context, oldApp, newApp *appsv1alpha1.NextApp) (admission.Warnings, error) {
	nextAppLog.Info("Validating NextApp on update", "name", newApp.GetName())
	var oldSpec *appsv1alpha1.NextAppSpec
	if oldApp != nil {
		oldSpec = &oldApp.Spec
	}
	return nil, validation.ValidateNextAppSpecUpdate(oldSpec, &newApp.Spec)
}

// ValidateDelete is a no-op: deletes are always allowed.
func (v *NextAppCustomValidator) ValidateDelete(_ context.Context, _ *appsv1alpha1.NextApp) (admission.Warnings, error) {
	return nil, nil
}
