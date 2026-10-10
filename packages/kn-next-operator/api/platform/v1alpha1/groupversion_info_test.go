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
	"errors"
	"testing"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// failingMapper is a RESTMapper whose RESTMapping always returns err: the shape
// of a discovery call that failed (a timeout, a 5xx, an aggregated API that is
// down) as opposed to one that answered "no such kind".
type failingMapper struct {
	meta.RESTMapper
	err error
}

func (m failingMapper) RESTMapping(schema.GroupKind, ...string) (*meta.RESTMapping, error) {
	return nil, m.err
}

func TestCRDInstalled_NoMatchMeansTheCRDIsAbsent(t *testing.T) {
	// An empty DefaultRESTMapper answers every lookup with a NoKindMatchError:
	// discovery worked and the cluster does not serve the kind.
	installed, err := CRDInstalled(meta.NewDefaultRESTMapper(nil))
	if err != nil {
		t.Fatalf("an absent CRD is an answer, not an error: %v", err)
	}
	if installed {
		t.Fatal("a mapper that does not know the kind must report the CRD absent")
	}
}

func TestCRDInstalled_ServedKindMeansInstalled(t *testing.T) {
	m := meta.NewDefaultRESTMapper([]schema.GroupVersion{GroupVersion})
	m.Add(GroupVersion.WithKind("KnextPlatform"), meta.RESTScopeRoot)
	installed, err := CRDInstalled(m)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !installed {
		t.Fatal("a mapper that serves the kind must report the CRD installed")
	}
}

// A discovery blip must NOT be read as "no CRD": that would silently switch the
// whole platform layer off for the life of the process, and a platform whose
// defaults were in force would stop being applied to every app.
func TestCRDInstalled_ADiscoveryErrorIsAnErrorNotAbsence(t *testing.T) {
	blip := errors.New("unable to retrieve the complete list of server APIs: context deadline exceeded")
	installed, err := CRDInstalled(failingMapper{err: blip})
	if err == nil {
		t.Fatal("a discovery failure must be returned to the caller, not swallowed as 'absent'")
	}
	if !errors.Is(err, blip) {
		t.Errorf("the underlying cause must stay reachable: %v", err)
	}
	if installed {
		t.Error("an unknown answer must not claim the CRD is installed either")
	}
}
