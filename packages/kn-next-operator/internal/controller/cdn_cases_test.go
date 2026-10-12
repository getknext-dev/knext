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
	"encoding/json"
	"fmt"
	"os"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

type cdnCase struct {
	Name  string               `json:"name"`
	Valid bool                 `json:"valid"`
	CDN   appsv1alpha1.CDNSpec `json:"cdn"`
}

// loadCDNCases reads the boundary table shared with the CLI's validate-cdn test.
// It panics on any problem so a missing or hollow table reds the suite instead
// of passing vacuously.
func loadCDNCases() []cdnCase {
	raw, err := os.ReadFile("../../../kn-next/src/__tests__/fixtures/cdn-validation-cases.json")
	if err != nil {
		panic(fmt.Sprintf("shared cdn table unreadable: %v", err))
	}
	var doc struct {
		Cases []cdnCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic(fmt.Sprintf("shared cdn table invalid: %v", err))
	}
	valid, invalid := 0, 0
	for _, c := range doc.Cases {
		if c.Valid {
			valid++
		} else {
			invalid++
		}
	}
	if valid < 15 || invalid < 20 {
		panic(fmt.Sprintf("shared cdn table is hollow: %d valid, %d invalid rows", valid, invalid))
	}
	return doc.Cases
}
