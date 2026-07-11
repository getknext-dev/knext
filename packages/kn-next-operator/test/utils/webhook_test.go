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

// Unit tests (no build tag, no cluster) for the webhook-readiness error
// classification behind WaitForWebhookReady (#233). The classification is the
// safety-critical piece: the e2e suites must retry ONLY the
// webhook-unreachability class (cert mount / server bind lag after the operator
// Deployment reports Available) and must NEVER spin on a genuine admission
// rejection — a rejection means the webhook answered, i.e. it IS ready, and
// blunting rejection detection would weaken the suites' admission assertions.

import "testing"

func TestClassifyWebhookApplyError(t *testing.T) {
	cases := []struct {
		name string
		msg  string
		want WebhookErrClass
	}{
		{
			// The exact signature reproduced twice on 2026-07-11 (issue #233).
			name: "webhook dial connection refused is retryable",
			msg: `Error from server (InternalError): error when creating "STDIN": ` +
				`Internal error occurred: failed calling webhook "vnextapp-v1alpha1.kb.io": ` +
				`failed to call webhook: Post "https://kn-next-operator-webhook-service.kn-next-operator-system.svc:443` +
				`/validate-apps-kn-next-dev-v1alpha1-nextapp?timeout=10s": ` +
				`dial tcp 10.96.145.23:443: connect: connection refused`,
			want: WebhookUnreachable,
		},
		{
			name: "webhook no endpoints available is retryable",
			msg: `Error from server (InternalError): error when creating "STDIN": ` +
				`Internal error occurred: failed calling webhook "vnextapp-v1alpha1.kb.io": ` +
				`failed to call webhook: ` +
				`no endpoints available for service "kn-next-operator-webhook-service"`,
			want: WebhookUnreachable,
		},
		{
			name: "webhook i/o timeout is retryable",
			msg: `Error from server (InternalError): error when creating "STDIN": ` +
				`Internal error occurred: failed calling webhook "vnextapp-v1alpha1.kb.io": ` +
				`failed to call webhook: Post "https://kn-next-operator-webhook-service.kn-next-operator-system.svc:443` +
				`/validate-apps-kn-next-dev-v1alpha1-nextapp?timeout=10s": ` +
				`dial tcp 10.96.145.23:443: i/o timeout`,
			want: WebhookUnreachable,
		},
		{
			// cert-manager's CA injector patches the webhook config's caBundle
			// asynchronously — same startup-race class as the dial errors.
			name: "webhook x509 unknown authority (caBundle not yet injected) is retryable",
			msg: `Error from server (InternalError): error when creating "STDIN": ` +
				`Internal error occurred: failed calling webhook "vnextapp-v1alpha1.kb.io": ` +
				`failed to call webhook: Post "https://kn-next-operator-webhook-service.kn-next-operator-system.svc:443` +
				`/validate-apps-kn-next-dev-v1alpha1-nextapp?timeout=10s": ` +
				`tls: failed to verify certificate: x509: certificate signed by unknown authority`,
			want: WebhookUnreachable,
		},
		{
			name: "webhook context deadline exceeded is retryable",
			msg: `Error from server (InternalError): error when creating "STDIN": ` +
				`Internal error occurred: failed calling webhook "vnextapp-v1alpha1.kb.io": ` +
				`failed to call webhook: Post "https://kn-next-operator-webhook-service.kn-next-operator-system.svc:443` +
				`/validate-apps-kn-next-dev-v1alpha1-nextapp?timeout=10s": ` +
				`context deadline exceeded`,
			want: WebhookUnreachable,
		},
		{
			// A genuine admission rejection means the webhook ANSWERED — the
			// readiness probe must treat it as ready, and the apply retry must
			// fail fast on it (never spin an admission bug into a timeout).
			name: "webhook denial (:latest rejection) means the webhook answered",
			msg: `Error from server (Forbidden): error when creating "STDIN": ` +
				`admission webhook "vnextapp-v1alpha1.kb.io" denied the request: ` +
				`spec.image: Invalid value: "nginx:latest": image must be pinned by digest; ":latest" tags are rejected`,
			want: WebhookAnswered,
		},
		{
			// CRD schema/CEL rejection (apiserver "is invalid"): the request got
			// through admission — same "answered, do not retry" class.
			name: "CEL/schema rejection means the request was admitted and validated",
			msg: `The NextApp "bundle-sample-app" is invalid: ` +
				`spec.database.secretRef.name: Invalid value: "": secretRef.name must not be empty`,
			want: WebhookAnswered,
		},
		{
			name: "immutable-field rejection means the webhook answered",
			msg: `Error from server (Forbidden): error when applying patch: ` +
				`admission webhook "vnextapp-v1alpha1.kb.io" denied the request: ` +
				`spec.database.mode: Invalid value: "byo": database mode is immutable once set`,
			want: WebhookAnswered,
		},
		{
			name: "namespace NotFound is an unrelated hard failure",
			msg:  `Error from server (NotFound): error when creating "STDIN": namespaces "kn-next-bundle-e2e" not found`,
			want: WebhookUnrelatedError,
		},
		{
			// A dead apiserver connection is NOT the webhook-lag class: no
			// "failed calling webhook" marker, so it must fail fast, not spin.
			name: "apiserver unreachable (no webhook marker) is an unrelated hard failure",
			msg:  `The connection to the server localhost:8080 was refused - did you specify the right host or port?`,
			want: WebhookUnrelatedError,
		},
		{
			name: "empty message is an unrelated hard failure",
			msg:  ``,
			want: WebhookUnrelatedError,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyWebhookApplyError(tc.msg); got != tc.want {
				t.Fatalf("ClassifyWebhookApplyError() = %v, want %v\nmessage: %s", got, tc.want, tc.msg)
			}
		})
	}
}
