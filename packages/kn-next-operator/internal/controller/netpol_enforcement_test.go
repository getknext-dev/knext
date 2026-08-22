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
)

// Unit tests for the pure CNI-enforcement classifier (#744). The contract
// under test: known policy-controller DaemonSets => enforced; flannel alone =>
// likely-unenforced; nothing recognized => unknown (the honest fallback — a
// classifier that guesses "enforced" is worse than none).

func TestClassifyCNIEnforcement_EnforcingControllers(t *testing.T) {
	cases := []struct {
		name string
		ds   dsRef
	}{
		{"calico", dsRef{"kube-system", "calico-node"}},
		{"calico-tigera", dsRef{"calico-system", "calico-node"}},
		{"cilium", dsRef{"kube-system", "cilium"}},
		{"kube-router", dsRef{"kube-system", "kube-router"}},
		{"weave", dsRef{"kube-system", "weave-net"}},
		{"antrea", dsRef{"kube-system", "antrea-agent"}},
		{"canal", dsRef{"kube-system", "canal"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			verdict, evidence := classifyCNIEnforcement([]dsRef{
				{"kube-system", "kube-proxy"}, // noise: never a signal
				tc.ds,
			})
			if verdict != netpolEnforcementEnforced {
				t.Fatalf("verdict = %v, want enforced", verdict)
			}
			if !strings.Contains(evidence, tc.ds.name) || !strings.Contains(evidence, tc.ds.namespace) {
				t.Fatalf("evidence %q does not name %s/%s", evidence, tc.ds.namespace, tc.ds.name)
			}
		})
	}
}

func TestClassifyCNIEnforcement_FlannelAloneIsLikelyUnenforced(t *testing.T) {
	for _, name := range []string{"kube-flannel-ds", "kube-flannel-ds-amd64", "flannel"} {
		verdict, evidence := classifyCNIEnforcement([]dsRef{
			{"kube-system", "kube-proxy"},
			{"kube-flannel", name},
		})
		if verdict != netpolEnforcementLikelyUnenforced {
			t.Fatalf("%s: verdict = %v, want likely-unenforced", name, verdict)
		}
		if !strings.Contains(evidence, name) {
			t.Fatalf("%s: evidence %q does not name the flannel DaemonSet", name, evidence)
		}
	}
}

// Canal ships flannel networking WITH felix (calico policy). A flannel-named
// DaemonSet must not outvote a policy controller.
func TestClassifyCNIEnforcement_EnforcerWinsOverFlannel(t *testing.T) {
	verdict, evidence := classifyCNIEnforcement([]dsRef{
		{"kube-system", "kube-flannel-ds"},
		{"kube-system", "calico-node"},
	})
	if verdict != netpolEnforcementEnforced {
		t.Fatalf("verdict = %v, want enforced (calico present)", verdict)
	}
	if !strings.Contains(evidence, "calico-node") {
		t.Fatalf("evidence %q does not name calico-node", evidence)
	}
}

func TestClassifyCNIEnforcement_NothingRecognizedIsUnknown(t *testing.T) {
	verdict, evidence := classifyCNIEnforcement([]dsRef{
		{"kube-system", "kube-proxy"},
		{"monitoring", "node-exporter"},
	})
	if verdict != netpolEnforcementUnknown {
		t.Fatalf("verdict = %v, want unknown", verdict)
	}
	if evidence != "" {
		t.Fatalf("evidence = %q, want empty for unknown", evidence)
	}
}

func TestClassifyCNIEnforcement_EmptyListIsUnknown(t *testing.T) {
	verdict, _ := classifyCNIEnforcement(nil)
	if verdict != netpolEnforcementUnknown {
		t.Fatalf("verdict = %v, want unknown for an empty cluster read", verdict)
	}
}

// Evidence must be deterministic (sorted) regardless of list order — the
// condition message embeds it, and the #98 no-op status guard DeepEquals
// status writes, so a shuffled informer list must not churn the message.
func TestClassifyCNIEnforcement_EvidenceIsOrderIndependent(t *testing.T) {
	a := []dsRef{{"kube-system", "cilium"}, {"calico-system", "calico-node"}}
	b := []dsRef{{"calico-system", "calico-node"}, {"kube-system", "cilium"}}
	_, evA := classifyCNIEnforcement(a)
	_, evB := classifyCNIEnforcement(b)
	if evA != evB {
		t.Fatalf("evidence depends on input order: %q vs %q", evA, evB)
	}
}
