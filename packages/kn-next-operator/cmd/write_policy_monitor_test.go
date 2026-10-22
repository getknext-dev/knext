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

package main

import (
	"os"
	"strings"
	"testing"
	"time"

	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/manager"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/writepolicy"
)

// The write-policy self-check (internal/writepolicy) only reports anything if
// main wires it in. These tests pin the wiring: the monitor is registered, it
// runs on every replica, and it reads the policy name the bundle rendered.

func TestAddWritePolicyMonitorRegistersAnEveryReplicaMonitor(t *testing.T) {
	var added []manager.Runnable
	add := func(r manager.Runnable) error {
		added = append(added, r)
		return nil
	}
	// Building a clientset does not dial; nothing is read here.
	if err := addWritePolicyMonitor(add, &rest.Config{Host: "https://127.0.0.1:1"}, "kn-next-operator-secret-configmap-writes", 7*time.Minute); err != nil {
		t.Fatal(err)
	}
	if len(added) != 1 {
		t.Fatalf("want one runnable added, got %d", len(added))
	}
	m, ok := added[0].(*writepolicy.Monitor)
	if !ok {
		t.Fatalf("the runnable is %T, want *writepolicy.Monitor", added[0])
	}
	if m.Name != "kn-next-operator-secret-configmap-writes" || m.Interval != 7*time.Minute {
		t.Errorf("monitor name/interval = %q/%v, not the configured ones", m.Name, m.Interval)
	}
	if le, ok := added[0].(manager.LeaderElectionRunnable); !ok || le.NeedLeaderElection() {
		t.Error("the monitor must opt out of leader election: a standby replica must report the gauge too")
	}
}

func TestWritePolicyNameComesFromTheRenderedEnvironment(t *testing.T) {
	if got := writePolicyNameDefault(func(string) string { return "" }); got != "secret-configmap-writes" {
		t.Errorf("unset env must default to the unprefixed shipped name, got %q", got)
	}
	got := writePolicyNameDefault(func(k string) string {
		if k == "WRITE_POLICY_NAME" {
			return "acme-secret-configmap-writes"
		}
		return ""
	})
	if got != "acme-secret-configmap-writes" {
		t.Errorf("WRITE_POLICY_NAME must override the default, got %q", got)
	}
}

// main() cannot be run in a test, so scan it: the monitor must be added to the
// manager, exactly once, and be configurable.
func TestMainRegistersTheWritePolicyMonitor(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	if n := strings.Count(src, "addWritePolicyMonitor(mgr.Add"); n != 1 {
		t.Errorf("main() must call addWritePolicyMonitor(mgr.Add, ...) exactly once, found %d", n)
	}
	for _, want := range []string{`"write-policy-name"`, `"write-policy-check-interval"`, "writePolicyNameDefault(os.Getenv)"} {
		if !strings.Contains(src, want) {
			t.Errorf("main.go lacks %s", want)
		}
	}
}
