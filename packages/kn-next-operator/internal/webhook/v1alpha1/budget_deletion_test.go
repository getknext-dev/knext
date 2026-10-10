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

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// A lowered connectionBudget must never wedge deletion: the operator's
// finalizer-removal patch is an UPDATE and goes through this webhook.

func TestAdmission_DeletingAnOverBudgetAppAlwaysPasses(t *testing.T) {
	ctx := context.Background()
	v := &NextAppCustomValidator{Platform: platformReader(t, budgetOf(40))}

	old := appWithWall(10, 10) // 100 > 40
	now := metav1.Now()
	deleting := appWithWall(10, 10)
	deleting.DeletionTimestamp = &now
	deleting.Finalizers = nil

	if _, err := v.ValidateUpdate(ctx, old, deleting); err != nil {
		t.Errorf("the finalizer-removal update of a terminating over-budget app must pass, got %v", err)
	}

	// Once deletionTimestamp is set no spec validation applies at all.
	raisedWhileDeleting := appWithWall(20, 10)
	raisedWhileDeleting.DeletionTimestamp = &now
	if _, err := v.ValidateUpdate(ctx, old, raisedWhileDeleting); err != nil {
		t.Errorf("no spec validation once deletionTimestamp is set, got %v", err)
	}
}

func TestAdmission_MetadataOnlyUpdateOfAnOverBudgetAppPasses(t *testing.T) {
	ctx := context.Background()
	v := &NextAppCustomValidator{Platform: platformReader(t, budgetOf(40))}

	old := appWithWall(10, 10)
	labelled := appWithWall(10, 10)
	labelled.Labels = map[string]string{"team": "a"}
	labelled.Annotations = map[string]string{"note": "x"}
	labelled.Finalizers = []string{"apps.kn-next.dev/external-cleanup"}
	if _, err := v.ValidateUpdate(ctx, old, labelled); err != nil {
		t.Errorf("a metadata-only update must pass, got %v", err)
	}
}

// A metadata-only update changes no spec, so no spec rule applies to it at all:
// an app stored with a spec that is invalid today (a rule that tightened since)
// must still be able to have its finalizer removed or its labels edited.
func TestAdmission_MetadataOnlyUpdateSkipsSpecRulesEntirely(t *testing.T) {
	ctx := context.Background()
	v := &NextAppCustomValidator{}

	old := newNextApp(appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:v1.2.3"}) // tag-only: invalid today
	next := newNextApp(appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:v1.2.3"})
	next.Labels = map[string]string{"team": "a"}
	if _, err := v.ValidateUpdate(ctx, old, next); err != nil {
		t.Errorf("a metadata-only update must not re-run spec rules, got %v", err)
	}

	changed := newNextApp(appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:v1.2.4"})
	if _, err := v.ValidateUpdate(ctx, old, changed); err == nil {
		t.Error("a real spec change must still be validated")
	}
}

func TestAdmission_OverBudgetAppRatchet(t *testing.T) {
	ctx := context.Background()
	v := &NextAppCustomValidator{Platform: platformReader(t, budgetOf(40))}

	old := appWithWall(10, 10)
	imageBump := appWithWall(10, 10)
	imageBump.Spec.Image = "registry.example.com/app:v2@sha256:def456abc123"
	if _, err := v.ValidateUpdate(ctx, old, imageBump); err != nil {
		t.Errorf("an image-only update must pass on an over-budget app, got %v", err)
	}

	raised := appWithWall(11, 10)
	if _, err := v.ValidateUpdate(ctx, old, raised); err == nil {
		t.Error("an update that raises the footprint above the budget must still be rejected")
	}
}
