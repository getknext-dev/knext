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

// Webhook-readiness helpers (#233).
//
// `kubectl wait deployment --for=condition=Available` on the operator does NOT
// imply its validating webhook (vnextapp-v1alpha1.kb.io) is serving: the
// serving-cert mount, the webhook server's TLS bind, and cert-manager's
// caBundle injection can all lag the Deployment's Available condition. On a
// slow runner the e2e suites' first NextApp apply landed entirely inside that
// gap and failed with `failed calling webhook ... connect: connection refused`
// (reproduced twice on 2026-07-11, issue #233).
//
// WaitForWebhookReady closes the race: it retries a side-effect-free
// `kubectl apply --dry-run=server` of a valid, digest-pinned NextApp until the
// webhook stops failing with the UNREACHABILITY class. Classification is the
// safety-critical piece and lives in a pure function (ClassifyWebhookApplyError,
// unit-tested in webhook_test.go):
//
//   - unreachable (connection refused / no endpoints / i/o timeout / TLS-CA
//     not injected, all gated on the "failed calling webhook" marker) → retry;
//   - a GENUINE admission rejection (denied the request / "is invalid")
//     → the webhook ANSWERED, i.e. it is ready → return success immediately.
//     Never spin on a rejection: that would blunt the suites' admission
//     assertions into timeouts;
//   - anything else (NotFound, dead apiserver, …) → hard failure, no retry.

import (
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2" // nolint:revive,staticcheck
)

// WebhookErrClass classifies the error output of a kubectl apply that may have
// hit the operator's validating webhook.
type WebhookErrClass int

const (
	// WebhookUnrelatedError — not a webhook signal at all (NotFound, dead
	// apiserver, bad kubeconfig, …). Callers must fail fast, not retry.
	WebhookUnrelatedError WebhookErrClass = iota
	// WebhookUnreachable — the apiserver could not reach the webhook server
	// (startup race: cert mount / server bind / caBundle injection). Retryable.
	WebhookUnreachable
	// WebhookAnswered — the request was admission-checked and REJECTED on its
	// merits (webhook denial or CRD schema/CEL). The webhook path is serving;
	// readiness probes count this as ready, apply retries must fail fast.
	WebhookAnswered
)

// webhookUnreachableRe matches ONLY the transport-level unreachability class,
// and ONLY when the apiserver names the webhook call as the failing hop
// ("failed calling webhook"). A plain `connection refused` from a dead
// apiserver deliberately does NOT match — that is not the startup race and
// must fail fast. `(?s)` lets the marker and the dial error span kubectl's
// wrapped/multi-line output.
var webhookUnreachableRe = regexp.MustCompile(`(?s)failed calling webhook.*(` +
	`connection refused` + // webhook pod up, server not bound yet
	`|no endpoints available` + // webhook Service has no ready endpoints yet
	`|i/o timeout` + // dial timed out inside the startup gap
	`|context deadline exceeded` + // same, surfaced as the call's deadline
	`|x509: certificate signed by unknown authority` + // caBundle not injected yet
	`)`)

// webhookAnsweredRe matches genuine admission rejections: an explicit webhook
// denial, or the apiserver's schema/CEL "is invalid" (the request traversed
// admission). Both mean the control plane ANSWERED — never retry these.
var webhookAnsweredRe = regexp.MustCompile(`denied the request|is invalid:`)

// ClassifyWebhookApplyError classifies a kubectl apply error message. Pure and
// unit-tested (webhook_test.go) — the e2e retry loops delegate to it so the
// retry-vs-fail-fast split can never silently drift.
func ClassifyWebhookApplyError(msg string) WebhookErrClass {
	switch {
	case webhookUnreachableRe.MatchString(msg):
		return WebhookUnreachable
	case webhookAnsweredRe.MatchString(msg):
		return WebhookAnswered
	default:
		return WebhookUnrelatedError
	}
}

const (
	webhookReadyTimeout = 4 * time.Minute
	webhookReadyPoll    = 3 * time.Second
)

// webhookProbeManifest renders the minimal VALID (digest-pinned) NextApp used
// as the dry-run probe. --dry-run=server exercises the full admission chain
// (including the validating webhook) but never persists anything, so the probe
// is a pure read even on a shared existing cluster. The namespace must already
// exist (the NamespaceLifecycle admission plugin rejects creates into a
// missing namespace before webhooks run).
func webhookProbeManifest(ns string) string {
	image := "ghcr.io/getknext-dev/webhook-readiness-probe@sha256:" +
		"0000000000000000000000000000000000000000000000000000000000000000"
	return fmt.Sprintf(`apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: webhook-readiness-probe
  namespace: %s
spec:
  image: %q
`, ns, image)
}

// WaitForWebhookReady blocks until the operator's validating webhook actually
// serves admission requests, by retrying a server-side dry-run apply of a
// valid NextApp into ns (which must already exist). It returns nil as soon as
// the webhook ANSWERS — a clean dry-run success OR a genuine admission
// rejection both count as ready. Only the unreachability class is retried;
// any other error fails immediately. Bounded at webhookReadyTimeout with the
// last kubectl output in the failure message.
func WaitForWebhookReady(ns string) error {
	manifest := webhookProbeManifest(ns)
	deadline := time.Now().Add(webhookReadyTimeout)
	for attempt := 1; ; attempt++ {
		cmd := exec.Command("kubectl", "apply", "--dry-run=server", "-f", "-")
		cmd.Stdin = strings.NewReader(manifest)
		_, err := Run(cmd)
		if err == nil {
			_, _ = fmt.Fprintf(GinkgoWriter,
				"webhook readiness: dry-run apply succeeded on attempt %d — webhook is serving\n", attempt)
			return nil
		}

		switch ClassifyWebhookApplyError(err.Error()) {
		case WebhookAnswered:
			// The webhook (or the CRD validation behind it) processed the
			// request — it is serving. The rejection itself is not this
			// helper's concern; the caller's real apply will surface it.
			_, _ = fmt.Fprintf(GinkgoWriter,
				"webhook readiness: admission ANSWERED with a rejection on attempt %d — webhook is serving: %v\n",
				attempt, err)
			return nil
		case WebhookUnreachable:
			if time.Now().After(deadline) {
				return fmt.Errorf(
					"validating webhook still unreachable after %s (%d dry-run attempts) — "+
						"the operator Deployment is Available but its webhook server never came up; last error: %w",
					webhookReadyTimeout, attempt, err)
			}
			_, _ = fmt.Fprintf(GinkgoWriter,
				"webhook readiness: attempt %d hit the unreachability class, retrying in %s: %v\n",
				attempt, webhookReadyPoll, err)
			time.Sleep(webhookReadyPoll)
		default:
			return fmt.Errorf(
				"webhook readiness probe failed with an error OUTSIDE the webhook-unreachability class "+
					"(not retrying — this is not the startup race): %w", err)
		}
	}
}
