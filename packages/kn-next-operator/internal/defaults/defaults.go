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

// Package defaults is the operator's ONE table of built-in values (ADR-0064
// D2, action P0-2): what a NextApp gets for a field it leaves unset when no
// KnextPlatform says otherwise.
//
// Every value here is the value the operator used before the platform layer
// existed, moved without change. The zero-diff golden
// (internal/controller/zero_diff_golden_test.go) and the pin test beside this
// file both red if one of them moves, because a change here is a behaviour
// change for every cluster that has not opted in. A built-in changes only
// through a reviewed PR that cites a measurement (ADR-0064 D9), never as a
// side effect of editing this file.
//
// They are constants so nothing can mutate the table at runtime and so the
// layers that need a number (the reconciler, the admission validator) share
// ONE definition instead of two literals that can drift.
package defaults

const (
	// ContainerConcurrency is the per-pod concurrent-request soft target stamped
	// on the generated Knative Service when spec.scaling.containerConcurrency is
	// unset (ADR-0028).
	ContainerConcurrency = 20

	// CPURequest, CPULimit, MemoryRequest and MemoryLimit are the container
	// resources stamped when the matching spec.resources field is unset. The
	// 1000m CPU limit is deliberate: a larger limit against the 250m request
	// trips a LimitRange maxLimitRequestRatio on clusters that set one.
	CPURequest    = "250m"
	CPULimit      = "1000m"
	MemoryRequest = "512Mi"
	MemoryLimit   = "1Gi"

	// TimeoutSeconds is the Knative request timeout stamped when
	// spec.timeoutSeconds is unset.
	TimeoutSeconds = 300

	// ConnectionBudget is the connection budget maxScale x poolMax must fit
	// within when an app declares a poolMax (ADR-0028): the wake gateway's 90
	// connection cap minus ~10 for admin and replication headroom.
	ConnectionBudget = 80

	// MaxAppsPerMinute bounds platform-triggered re-renders once a KnextPlatform
	// exists (ADR-0064 failure mode F2). With no KnextPlatform nothing is
	// platform-triggered, so this value never acts.
	MaxAppsPerMinute = 10
)
