//go:build e2e_scale

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

package e2e

import (
	"os/exec"
	"strings"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

// Shared helpers for the `e2e_scale` suite.
//
// WHY THIS FILE EXISTS. `applyManifest` used to live inside
// scale_to_zero_cache_test.go — one SPEC among several — while three call sites in
// TWO OTHER specs depended on it. Deleting that spec (the bytecode-cache PVC removal)
// therefore broke the whole suite's BUILD, not just its own coverage:
//
//	go vet -tags e2e_scale ./test/...
//	vet: test/e2e/image_prewarm_e2e_test.go:102:10: undefined: applyManifest
//
// and nothing caught it, because `go build ./...` and an untagged `go vet ./...` are
// both green — a tagged suite is invisible to them. A build failure here is worse than
// a test failure: the nightly lane goes red at compile time, so the activation
// (#39) and image-prewarm (#471) invariants stop running ENTIRELY rather than
// reporting a result.
//
// Suite-wide helpers therefore belong in a suite-scoped file, not in whichever spec
// happened to need one first. Anything shared by more than one spec in this build tag
// goes here.

// scaleAppImageDefault is the fallback image for the scale suite, overridden by the
// SCALE_TEST_IMAGE env var in the nightly workflow.
//
// The all-zeros digest is DELIBERATELY UNPULLABLE and must stay that way: the nightly
// lane's preflight job (operator-e2e-nightly.yml, #659) rejects this exact value so a
// run cannot proceed against a placeholder and report success having pulled nothing.
// Replacing it with a real-looking digest would silently disarm that check.
//
// It shared the deleted spec's `const` block, so it went out with the bytecode-cache
// PVC removal even though image_prewarm_e2e_test.go still depends on it.
const scaleAppImageDefault = "dev.local/file-manager@sha256:0000000000000000000000000000000000000000000000000000000000000000"

func applyManifest(manifest string) error {
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(manifest)
	_, err := utils.Run(cmd)
	return err
}
