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

package utils

// #1208: the e2e_cli / e2e_rollback / e2e_gc nightly suites were red on every
// run from 2026-09-05 because each BeforeAll shelled out to `pnpm --filter
// @getknext/core... build` after the monorepo moved to Bun (root package.json
// `packageManager: bun@…`, no pnpm on the runner): `exec: "pnpm": executable
// file not found in $PATH`. The e2e suites are build-tagged and only run
// nightly, so nothing on the PR path saw it. These untagged tests run in
// `make test` (go test ./test/utils/) and pin the toolchain on the PR path.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// rootPackageManager returns the tool name from the root package.json's
// `packageManager` field (e.g. "bun" for "bun@1.4.2").
func rootPackageManager(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "package.json"))
	if err != nil {
		t.Fatalf("could not read the root package.json: %v", err)
	}
	var pkg struct {
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatalf("root package.json is not JSON: %v", err)
	}
	name, _, _ := strings.Cut(pkg.PackageManager, "@")
	if name == "" {
		t.Fatalf("root package.json has no packageManager field")
	}
	return name
}

func TestBuildCLIStepsUseTheRepoPackageManager(t *testing.T) {
	pm := rootPackageManager(t)
	steps := BuildCLISteps()
	if len(steps) == 0 {
		t.Fatalf("BuildCLISteps returned no steps")
	}
	for i, s := range steps {
		if len(s) == 0 || s[0] != pm {
			t.Errorf("step %d %q must invoke the repo package manager %q", i, s, pm)
		}
	}
}

func TestBuildCLIStepsBuildCoreAfterItsWorkspaceDeps(t *testing.T) {
	// @getknext/lib ships only dist/ and core's dts build imports
	// @getknext/lib/clients, so on a clean checkout core must build LAST.
	var order []string
	for _, s := range BuildCLISteps() {
		joined := strings.Join(s, " ")
		for _, pkg := range []string{"@getknext/lib", "@getknext/db", "@getknext/core"} {
			if strings.Contains(joined, "--filter "+pkg+" build") {
				order = append(order, pkg)
			}
		}
	}
	want := []string{"@getknext/lib", "@getknext/db", "@getknext/core"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("build order = %v, want %v", order, want)
	}
}

// Scan, don't enumerate: every e2e spec must build the CLI through BuildCLI,
// never by hand-rolling a toolchain invocation that can rot out of sync with
// the repo's package manager again.
func TestE2ESuitesDoNotHandRollTheCLIBuild(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "e2e", "*.go"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no e2e sources found (err=%v)", err)
	}
	direct := regexp.MustCompile(`RunAtRepoRoot\(`)
	pnpm := regexp.MustCompile(`"pnpm"`)
	callers := 0
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		if direct.Match(src) {
			t.Errorf("%s calls RunAtRepoRoot directly — use utils.BuildCLI()", f)
		}
		if pnpm.Match(src) {
			t.Errorf("%s invokes pnpm, which is not this repo's package manager", f)
		}
		if strings.Contains(string(src), "utils.BuildCLI()") {
			callers++
		}
	}
	// e2e_cli, e2e_rollback, e2e_gc — both halves: the helper must actually be
	// used, not merely the old call removed.
	if callers < 3 {
		t.Fatalf("utils.BuildCLI() is called from %d e2e files, want >= 3", callers)
	}
}
