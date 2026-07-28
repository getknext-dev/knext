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

// Unit tests (no build tag, no cluster) for DiagnoseApplyFailure — the function
// that keeps a WEBHOOK OUTAGE from being misread as CLI/operator SKEW (#314,
// sprint 2 S11). Both present at the CLI as "the apply failed", and a user who
// reads a webhook outage as a version-skew problem downgrades their CLI, which
// does nothing at all. The messages below are the real shapes kubectl emits.

import "testing"

func TestDiagnoseApplyFailure(t *testing.T) {
	cases := []struct {
		name string
		msg  string
		want ApplyFailure
	}{
		{
			name: "webhook down — no endpoints (operator scaled to zero)",
			msg: `Error from server (InternalError): error when creating "STDIN": ` +
				`Internal error occurred: failed calling webhook "vnextapp-v1alpha1.kb.io": ` +
				`failed to call webhook: Post "https://kn-next-operator-webhook-service.` +
				`kn-next-operator-system.svc:443/validate-apps-kn-next-dev-v1alpha1-nextapp?timeout=10s": ` +
				`no endpoints available for service "kn-next-operator-webhook-service"`,
			want: FailureWebhookDown,
		},
		{
			name: "webhook down — connection refused (pod up, server not bound)",
			msg: `Error from server (InternalError): error when creating "STDIN": ` +
				`Internal error occurred: failed calling webhook "vnextapp-v1alpha1.kb.io": ` +
				`failed to call webhook: Post "https://…/validate-apps-kn-next-dev-v1alpha1-nextapp": ` +
				`dial tcp 10.96.0.12:443: connect: connection refused`,
			want: FailureWebhookDown,
		},
		{
			name: "webhook down — dial timeout",
			msg: `Internal error occurred: failed calling webhook "vnextapp-v1alpha1.kb.io": ` +
				`failed to call webhook: Post "https://…": dial tcp 10.96.0.12:443: i/o timeout`,
			want: FailureWebhookDown,
		},
		{
			name: "skew — server-side strict decoding rejects an unknown field",
			msg: `Error from server (BadRequest): error when creating "STDIN": ` +
				`NextApp in version "v1alpha1" cannot be handled as a NextApp: ` +
				`strict decoding error: unknown field "spec.database.roSecretRef"`,
			want: FailureSchemaSkew,
		},
		{
			name: "skew — client-side validation names an unknown field",
			msg: `error: error validating data: ValidationError(NextApp.spec): ` +
				`unknown field "database" in dev.kn-next.apps.v1alpha1.NextApp.spec`,
			want: FailureSchemaSkew,
		},
		{
			name: "skew — the CRD version the CLI emits is not served",
			msg: `error: unable to recognize "STDIN": no matches for kind "NextApp" ` +
				`in version "apps.kn-next.dev/v1beta1"`,
			want: FailureSchemaSkew,
		},
		{
			// THE DISCRIMINATING CASE. With the webhook DOWN, an unknown field
			// still fails as skew: the apiserver decodes and field-validates the
			// request BEFORE it calls any validating webhook, so the outage never
			// even enters the message. Cluster state is identical to the
			// webhook-down case above; only the payload differs.
			name: "skew is still skew while the webhook is down (decode precedes admission)",
			msg: `Error from server (BadRequest): error when creating "STDIN": ` +
				`NextApp in version "v1alpha1" cannot be handled as a NextApp: ` +
				`strict decoding error: unknown field "spec.newFieldTheOldCRDLacks"`,
			want: FailureSchemaSkew,
		},
		{
			name: "admission rejection — the webhook ANSWERED and said no",
			msg: `Error from server (Forbidden): error when creating "STDIN": ` +
				`admission webhook "vnextapp-v1alpha1.kb.io" denied the request: ` +
				`spec.image must be digest-pinned (@sha256:…), got ":latest"`,
			want: FailureAdmissionRejected,
		},
		{
			name: "schema/CEL rejection — the control plane answered on the merits",
			msg: `The NextApp "demo" is invalid: spec.image: Invalid value: "": ` +
				`spec.image in body should be at least 1 chars long`,
			want: FailureAdmissionRejected,
		},
		{
			name: "unrelated — namespace missing",
			msg:  `Error from server (NotFound): namespaces "nope" not found`,
			want: FailureUnrelated,
		},
		{
			// A bare connection refused is the APISERVER being unreachable, not
			// the webhook. Never diagnose that as a webhook outage: the operator
			// is not the thing to look at.
			name: "unrelated — the apiserver itself is unreachable",
			msg:  `The connection to the server localhost:8080 was refused - did you specify the right host or port?`,
			want: FailureUnrelated,
		},
		{
			name: "unrelated — success has no diagnosis",
			msg:  ``,
			want: FailureUnrelated,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DiagnoseApplyFailure(tc.msg)
			if got != tc.want {
				t.Fatalf("DiagnoseApplyFailure() = %v, want %v\nmessage: %s", got, tc.want, tc.msg)
			}
		})
	}
}

// TestDiagnosisSkewAndWebhookDownAreDisjoint is the property that matters for
// diagnosis: the two failure modes must never collapse into one another. If a
// message ever satisfied both predicates, the precedence rule (decode-then-admit)
// must resolve it to skew — never to a webhook outage, because "your webhook is
// down" sends the operator to restart a controller while the real problem is the
// payload.
func TestDiagnosisSkewAndWebhookDownAreDisjoint(t *testing.T) {
	both := `Error from server (BadRequest): error when creating "STDIN": ` +
		`strict decoding error: unknown field "spec.brandNew" ` +
		`(previous attempt: Internal error occurred: failed calling webhook ` +
		`"vnextapp-v1alpha1.kb.io": failed to call webhook: no endpoints available)`

	if got := DiagnoseApplyFailure(both); got != FailureSchemaSkew {
		t.Fatalf("a message carrying BOTH markers must resolve to skew, got %v", got)
	}
}

// TestDiagnosisRemediationsAreDistinct guards the whole point of the split: the
// operator-facing advice for a webhook outage must not tell anyone to change
// their CLI version, and the skew advice must not send anyone to restart the
// operator. Identical or empty guidance would make the classification useless
// even when it is correct.
func TestDiagnosisRemediationsAreDistinct(t *testing.T) {
	down := FailureWebhookDown.Remediation()
	skew := FailureSchemaSkew.Remediation()

	if down == "" || skew == "" {
		t.Fatal("every diagnosable failure must carry remediation text")
	}
	if down == skew {
		t.Fatal("webhook-down and skew must not share remediation text")
	}
	if !containsFold(skew, "operator") || !containsFold(skew, "crd") {
		t.Fatalf("skew remediation must point at the operator/CRD upgrade order, got: %q", skew)
	}
	if containsFold(down, "downgrade") {
		t.Fatalf("webhook-down remediation must never suggest downgrading anything, got: %q", down)
	}
}

func containsFold(haystack, needle string) bool {
	return len(needle) > 0 && indexFold(haystack, needle) >= 0
}

func indexFold(s, substr string) int {
	ls, lsub := len(s), len(substr)
	for i := 0; i+lsub <= ls; i++ {
		match := true
		for j := 0; j < lsub; j++ {
			if lower(s[i+j]) != lower(substr[j]) {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func lower(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}
