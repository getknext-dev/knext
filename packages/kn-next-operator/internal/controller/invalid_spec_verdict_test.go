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
	"errors"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The verdict seam itself, as a table: the outcome comes from computeStatusVerdict
// with no ksvc, database or revision input at all.
func TestComputeStatusVerdict_InvalidSpec(t *testing.T) {
	now := time.Now()
	specErr := errors.New("spec.scaling.maxScale must be >= 0, got -1")
	imageErr := errors.New(`image "x:latest" uses the :latest tag which is forbidden`)
	cases := []struct {
		name       string
		err        error
		image      string
		wantReason string
	}{
		{"spec error", specErr, platformTestImage, ReasonInvalidSpec},
		{"unpinned image", imageErr, "x:latest", ReasonInvalidImage},
		{"empty image", errors.New("spec.image is required"), "", ReasonInvalidImage},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			app := verdictApp()
			app.Spec.Image = c.image
			v := computeStatusVerdict(app, nil, databaseCheckState{}, revisionCheck{}, imageCacheState{},
				netpolEnforcementState{}, envMapCollisionReport{}, privateExposureState{}, podCreationState{},
				now, withInvalidSpec(c.err))

			if got := conditionTypes(v); len(got) != 2 || got[0] != ConditionDegraded || got[1] != ConditionReady {
				t.Fatalf("conditions = %v, want [Degraded Ready]", got)
			}
			d := findVerdictCondition(t, v, ConditionDegraded)
			if d.Status != metav1.ConditionTrue || d.Reason != lcInvalidSpec ||
				d.Message != c.err.Error() || d.ObservedGeneration != app.Generation {
				t.Errorf("Degraded = %+v", d)
			}
			r := findVerdictCondition(t, v, ConditionReady)
			if r.Status != metav1.ConditionFalse || r.Reason != lcInvalidSpec ||
				r.Message != invalidSpecReadyMessage || r.ObservedGeneration != app.Generation {
				t.Errorf("Ready = %+v", r)
			}
			if len(v.removeConditions) != 0 || v.requeueAfter != 0 {
				t.Errorf("remove=%v requeue=%v, want none", v.removeConditions, v.requeueAfter)
			}
			want := "Spec rejected: " + c.err.Error()
			if len(v.events) != 1 || v.events[0].eventType != corev1.EventTypeWarning ||
				v.events[0].reason != c.wantReason || v.events[0].message != want {
				t.Errorf("events = %+v, want one Warning %s %q", v.events, c.wantReason, want)
			}
		})
	}
}

// Without the input, the verdict is the ordinary one: the option is the only
// way into the invalid-spec outcome.
func TestComputeStatusVerdict_NoInvalidSpecInputIsTheOrdinaryVerdict(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{}, revisionCheck{}, imageCacheState{},
		netpolEnforcementState{}, envMapCollisionReport{}, privateExposureState{}, podCreationState{}, now)
	if r := findVerdictCondition(t, v, ConditionReady); r.Status != metav1.ConditionTrue {
		t.Errorf("Ready = %+v, want True", r)
	}
	for _, c := range v.conditions {
		if c.Reason == lcInvalidSpec {
			t.Errorf("condition %+v carries InvalidSpec without the invalid-spec input", c)
		}
	}
}

// withInvalidSpec(nil) is still a rejected spec: the early return is keyed on the
// option having been supplied, not on the error being non-nil, so a nil error can
// never fall through to the observed-state roll-up (which dereferences the ksvc).
func TestComputeStatusVerdict_InvalidSpecWithNilError(t *testing.T) {
	t.Run("withInvalidSpec(nil)", func(t *testing.T) {
		// Exercises the option itself: it must set the flag even for a nil error.
		assertRejectedSpecVerdict(t, computeStatusVerdict(verdictApp(), nil, databaseCheckState{},
			revisionCheck{}, imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{},
			privateExposureState{}, podCreationState{}, time.Now(), withInvalidSpec(nil)))
	})
	t.Run("flag set with a nil error", func(t *testing.T) {
		// Set the flag with a nil error directly: the early return must key on the
		// flag, so reverting it to `invalidSpec != nil` falls through and panics.
		assertRejectedSpecVerdict(t, computeStatusVerdict(verdictApp(), nil, databaseCheckState{},
			revisionCheck{}, imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{},
			privateExposureState{}, podCreationState{}, time.Now(), func(x *verdictExtras) {
				*x = verdictExtras{invalidSpecSet: true}
			}))
	})
}

func assertRejectedSpecVerdict(t *testing.T, v statusVerdict) {
	t.Helper()
	if got := conditionTypes(v); len(got) != 2 || got[0] != ConditionDegraded || got[1] != ConditionReady {
		t.Fatalf("conditions = %v, want [Degraded Ready]", got)
	}
	if d := findVerdictCondition(t, v, ConditionDegraded); d.Reason != lcInvalidSpec || d.Message == "" {
		t.Errorf("Degraded = %+v, want InvalidSpec with a non-empty message", d)
	}
	if len(v.events) != 1 || v.events[0].eventType != corev1.EventTypeWarning {
		t.Errorf("events = %+v, want one Warning", v.events)
	}
}
