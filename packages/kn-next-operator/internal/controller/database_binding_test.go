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
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/record"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The admission rules (ADR-0019) reject a CR that defines DATABASE_URL in both
// spec.database and spec.secrets.envMap — but CRs that PREDATE those rules can
// still reach the reconciler with both set (CRD validation ratcheting). The
// binding must then win LOUDLY: spec.database overrides and a Warning event
// names the ignored envMap entry (#186/#191 collision-event semantics).
func TestInjectBoundDatabaseEnvOverridesEnvMapWithWarning(t *testing.T) {
	rec := record.NewFakeRecorder(8)
	r := &NextAppReconciler{Recorder: rec}
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "legacy", Namespace: "default"},
		Spec: appsv1alpha1.NextAppSpec{
			Database: &appsv1alpha1.DatabaseSpec{
				SecretRef: &appsv1alpha1.DatabaseSecretRef{Name: "shop-db"},
			},
			Secrets: &appsv1alpha1.SecretsSpec{
				EnvMap: map[string]appsv1alpha1.EnvMapEntry{
					"DATABASE_URL": {SecretName: "stale", SecretKey: "url"},
				},
			},
		},
	}

	r.injectBoundDatabaseEnv(app)

	got := app.Spec.Secrets.EnvMap["DATABASE_URL"]
	if got.SecretName != "shop-db" || got.SecretKey != "DATABASE_URL" {
		t.Fatalf("spec.database.secretRef must override the stale envMap entry, got %+v", got)
	}

	select {
	case ev := <-rec.Events:
		if !strings.Contains(ev, "Warning") || !strings.Contains(ev, "DATABASE_URL") {
			t.Fatalf("expected a Warning event naming DATABASE_URL, got %q", ev)
		}
	default:
		t.Fatal("expected a Warning event for the overridden envMap entry, got none (silent precedence is forbidden)")
	}
}

// A clean binding (no author envMap collision) must inject WITHOUT any event noise.
func TestInjectBoundDatabaseEnvCleanNoEvent(t *testing.T) {
	rec := record.NewFakeRecorder(8)
	r := &NextAppReconciler{Recorder: rec}
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "clean", Namespace: "default"},
		Spec: appsv1alpha1.NextAppSpec{
			Database: &appsv1alpha1.DatabaseSpec{
				SecretRef:   &appsv1alpha1.DatabaseSecretRef{Name: "shop-db", Key: "uri"},
				ROSecretRef: &appsv1alpha1.DatabaseSecretRef{Name: "shop-db"},
			},
		},
	}

	r.injectBoundDatabaseEnv(app)

	if got := app.Spec.Secrets.EnvMap["DATABASE_URL"]; got.SecretName != "shop-db" || got.SecretKey != "uri" {
		t.Fatalf("explicit key must be honored, got %+v", got)
	}
	if got := app.Spec.Secrets.EnvMap["DATABASE_URL_RO"]; got.SecretName != "shop-db" || got.SecretKey != "DATABASE_URL_RO" {
		t.Fatalf("roSecretRef must default its key to DATABASE_URL_RO, got %+v", got)
	}
	select {
	case ev := <-rec.Events:
		t.Fatalf("expected no events for a clean binding, got %q", ev)
	default:
	}
}
