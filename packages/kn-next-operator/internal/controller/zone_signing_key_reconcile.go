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
	"crypto/rand"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The impure half of the zone signing key (zone_signing_key.go holds the rules).
//
// RBAC, and why it is this narrow (rbac_secrets_guard_test.go holds the
// justified entries; docs/security/threat-model.md the blast radius):
//   - Secrets: get (shared with the BackendService allowlist), create, update.
//     No list, no watch (both objects are read through the uncached APIReader,
//     so no Secret informer ever starts), no patch (every write is an Update
//     carrying the read resourceVersion, so a concurrent writer loses with a
//     Conflict instead of being overwritten), no delete (a zone that loses its
//     bindings keeps its key; the NextApp's ownerReference collects it).
//   - ConfigMaps: get, create, update, for the same reasons.
// The ownerReference is set at CREATE only and never changed afterwards, which
// is why delete is not needed even under OwnerReferencesPermissionEnforcement
// (the plugin requires delete only to CHANGE an existing object's owners).

// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;create;update
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;create;update

// uncachedReader is the reader for the key Secret and the JWKS ConfigMap: never
// the informer cache, which would need cluster-wide list/watch on Secrets.
func (r *NextAppReconciler) uncachedReader() client.Reader {
	if r.APIReader != nil {
		return r.APIReader
	}
	return r.Client
}

// controlledByZone reports whether obj's controller is this NextApp (by UID).
func controlledByZone(obj metav1.Object, app *appsv1alpha1.NextApp) bool {
	ref := metav1.GetControllerOf(obj)
	return ref != nil && ref.Kind == "NextApp" && ref.UID == app.UID && ref.Name == app.Name &&
		strings.HasPrefix(ref.APIVersion, appsv1alpha1.GroupVersion.Group+"/")
}

func zoneIdentityLabels(app *appsv1alpha1.NextApp) map[string]string {
	return map[string]string{"app": app.Name, "generated-by": "kn-next-operator"}
}

// reconcileZoneSigningKey brings the zone's key Secret and JWKS one or more
// steps forward (planZoneKeyStep), writing one object per step, and reports
// where they stand. A zone without a bound function is left alone. A Secret
// or ConfigMap of the reserved name that this NextApp does not control is
// never written (a squatter, or a leftover from an earlier NextApp of the same
// name awaiting garbage collection) and is reported instead. Every error it
// returns has passed through redactZoneKeyError.
func (r *NextAppReconciler) reconcileZoneSigningKey(ctx context.Context, app *appsv1alpha1.NextApp, bindings zoneBindings) (zoneSigningKeyState, error) {
	if !hasBoundFunction(bindings) {
		return zoneSigningKeyState{}, nil
	}
	in := zoneKeyInputs{
		now:            r.now(),
		cfg:            r.ZoneSigningKey.withDefaults(),
		requestedNonce: app.Annotations[RotateSigningKeyAnnotation],
	}
	secretName, jwksName := ZoneSigningKeySecretName(app.Name), ZoneJWKSConfigMapName(app.Name)
	problem := func(reason, msg string) zoneSigningKeyState {
		return zoneSigningKeyState{active: true, problemReason: reason, problemMessage: msg,
			secretName: secretName, jwksName: jwksName}
	}
	reader := r.uncachedReader()

	var w zoneKeyWorld
	sec := &corev1.Secret{}
	switch err := reader.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: secretName}, sec); {
	case apierrors.IsNotFound(err):
		sec = nil
	case err != nil:
		return zoneSigningKeyState{}, redactZoneKeyError(fmt.Errorf("reading Secret %s: %w", secretName, err), nil)
	case !controlledByZone(sec, app):
		return problem(ReasonSigningKeySecretConflict, fmt.Sprintf(
			"Secret %q exists but is not controlled by this NextApp, so the operator leaves it untouched and "+
				"publishes no key: the zone's calls to its functions fail closed. Remove it (if it belongs to an earlier "+
				"NextApp of the same name, garbage collection removes it shortly) and the operator creates the zone's key.",
			secretName)), nil
	default:
		keys, err := readSigningKeySecret(sec)
		if err != nil {
			return problem(ReasonSigningKeyInvalid, fmt.Sprintf(
				"Secret %q does not hold a valid zone signing key: %s. The operator does not overwrite it; delete "+
					"the Secret and the operator generates a new key (calls fail until the zone's pods read it).",
				secretName, err.Error())), nil
		}
		w.secretFound, w.keys = true, keys
	}
	cm := &corev1.ConfigMap{}
	switch err := reader.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: jwksName}, cm); {
	case apierrors.IsNotFound(err):
		cm = nil
	case err != nil:
		return zoneSigningKeyState{}, redactZoneKeyError(fmt.Errorf("reading ConfigMap %s: %w", jwksName, err), w.keys.keys())
	case !controlledByZone(cm, app):
		return problem(ReasonJWKSConfigMapConflict, fmt.Sprintf(
			"ConfigMap %q exists but is not controlled by this NextApp, so the operator leaves it untouched and "+
				"publishes no key in it: the zone's functions verify against whatever it holds. Remove it (if it belongs "+
				"to an earlier NextApp of the same name, garbage collection removes it shortly) and the operator "+
				"publishes the zone's keys.", jwksName)), nil
	default:
		w.jwksFound, w.jwks = true, cm.Data[ZoneJWKSFileName]
	}

	gen := func() (zoneKey, error) { return newZoneKey(rand.Reader) }
	persist := func(write zoneKeyWrite, action zoneKeyAction) error {
		var err error
		switch write {
		case zkWriteSecret:
			if sec, err = r.writeSigningKeySecret(ctx, app, sec, w.keys); err != nil {
				return fmt.Errorf("writing Secret %s (%s): %w", secretName, action, err)
			}
		case zkWriteJWKS:
			if cm, err = r.writeJWKSConfigMap(ctx, app, cm, w.jwks); err != nil {
				return fmt.Errorf("writing ConfigMap %s (%s): %w", jwksName, action, err)
			}
		}
		return nil
	}
	last, held, err := runZoneKeyPass(&w, &in, r.now, gen, persist)
	if err != nil {
		// held, not w.keys: RetirePrevious drops the previous key from memory
		// before its write, and a refusal can echo the STORED object, which
		// still carries it.
		return zoneSigningKeyState{}, redactZoneKeyError(err, held)
	}
	return zoneKeyStatusFrom(w, in, last, app.Name), nil
}

// writeSigningKeySecret creates the Secret (with the zone's controller
// ownerReference, set once, at create) or updates it with the read
// resourceVersion.
func (r *NextAppReconciler) writeSigningKeySecret(ctx context.Context, app *appsv1alpha1.NextApp, sec *corev1.Secret, keys signingKeySet) (*corev1.Secret, error) {
	if sec == nil {
		sec = &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{
				Name:      ZoneSigningKeySecretName(app.Name),
				Namespace: app.Namespace,
				Labels:    zoneIdentityLabels(app),
			},
			Type: corev1.SecretTypeOpaque,
		}
		keys.applyTo(sec)
		if err := ctrl.SetControllerReference(app, sec, r.Scheme); err != nil {
			return nil, err
		}
		if err := r.Create(ctx, sec); err != nil {
			return nil, err
		}
		return sec, nil
	}
	keys.applyTo(sec)
	if err := r.Update(ctx, sec); err != nil {
		return nil, err
	}
	return sec, nil
}

// rotationRequestChanged passes an update event only when the zone's
// RotateSigningKeyAnnotation value changed (set, changed or removed). It is
// OR-ed with the generation predicate on the NextApp watch, so a rotation
// request reconciles at once instead of at the next periodic re-check.
var rotationRequestChanged = predicate.Funcs{
	CreateFunc:  func(event.CreateEvent) bool { return false },
	DeleteFunc:  func(event.DeleteEvent) bool { return false },
	GenericFunc: func(event.GenericEvent) bool { return false },
	UpdateFunc: func(e event.UpdateEvent) bool {
		if e.ObjectOld == nil || e.ObjectNew == nil {
			return false
		}
		return e.ObjectOld.GetAnnotations()[RotateSigningKeyAnnotation] !=
			e.ObjectNew.GetAnnotations()[RotateSigningKeyAnnotation]
	},
}

// writeJWKSConfigMap creates or updates the JWKS ConfigMap with the derived
// document, the same way.
func (r *NextAppReconciler) writeJWKSConfigMap(ctx context.Context, app *appsv1alpha1.NextApp, cm *corev1.ConfigMap, jwks string) (*corev1.ConfigMap, error) {
	if cm == nil {
		cm = &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      ZoneJWKSConfigMapName(app.Name),
				Namespace: app.Namespace,
				Labels:    zoneIdentityLabels(app),
			},
			Data: map[string]string{ZoneJWKSFileName: jwks},
		}
		if err := ctrl.SetControllerReference(app, cm, r.Scheme); err != nil {
			return nil, err
		}
		if err := r.Create(ctx, cm); err != nil {
			return nil, err
		}
		return cm, nil
	}
	cm.Data = map[string]string{ZoneJWKSFileName: jwks}
	if err := r.Update(ctx, cm); err != nil {
		return nil, err
	}
	return cm, nil
}
