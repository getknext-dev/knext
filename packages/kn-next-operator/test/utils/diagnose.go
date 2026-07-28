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

// Apply-failure DIAGNOSIS (#314, sprint 2 S11) — distinguishing a webhook
// OUTAGE from CLI/operator SKEW.
//
// The validating webhook runs failurePolicy: Fail. That is correct fail-closed
// behaviour, and its consequence is that a webhook outage FREEZES DEPLOYS: the
// apiserver rejects every CREATE/UPDATE of a NextApp while the webhook cannot
// be reached. At the CLI that presents exactly like version skew — "the apply
// failed" — and the misdiagnosis is expensive in a specific way: a user who
// reads a webhook outage as skew downgrades their CLI, which changes nothing,
// while the operator stays down.
//
// So the two are separated here, mechanically, on the marker the apiserver
// itself emits:
//
//   - SKEW is decided at REQUEST DECODE / SCHEMA time — `strict decoding error:
//     unknown field`, a client-side `unknown field` ValidationError, or an
//     unserved apiVersion. None of these involve the webhook at all.
//   - WEBHOOK-DOWN is decided at ADMISSION time — the apiserver names the
//     webhook call as the failing hop ("failed calling webhook") and reports a
//     transport error underneath.
//   - An ADMISSION REJECTION means the webhook (or the CRD's own schema/CEL)
//     ANSWERED. The control plane is healthy; the CR is not acceptable.
//
// PRECEDENCE — skew before webhook-down, deliberately. The apiserver decodes
// and field-validates a request BEFORE it calls validating webhooks, so a
// skew-affected payload fails as skew EVEN WHILE THE WEBHOOK IS DOWN, and its
// message never mentions the webhook. That ordering is what makes the two
// diagnosable apart from a single failed apply, and the e2e
// (webhook_down_freeze_test.go) asserts it against a real cluster with the
// webhook actually scaled to zero. If a message ever carried both markers,
// resolving to skew is the safe answer: it points at the payload, which is what
// the earlier apiserver stage rejected.
//
// This deliberately does NOT reimplement unreachability detection — it reuses
// webhookUnreachableRe from webhook.go so the readiness probe and the diagnosis
// can never drift into disagreeing about what "the webhook is down" looks like.

import "regexp"

// ApplyFailure is the diagnosis of a failed `kubectl apply` of a NextApp.
type ApplyFailure int

const (
	// FailureUnrelated — not a knext control-plane signal (missing namespace,
	// unreachable apiserver, bad kubeconfig). Notably a BARE "connection
	// refused" lands here: that is the apiserver, not the webhook, and
	// diagnosing it as a webhook outage sends the reader to the wrong system.
	FailureUnrelated ApplyFailure = iota
	// FailureWebhookDown — the apiserver could not reach the validating
	// webhook. Under failurePolicy: Fail this FREEZES deploys. Nothing was
	// persisted. Not a skew problem; changing CLI versions cannot help.
	FailureWebhookDown
	// FailureSchemaSkew — the CRD installed on the cluster does not know what
	// the client sent (unknown field, or an unserved apiVersion). This is the
	// CLI-newer-than-operator case, and it is decided before admission runs.
	FailureSchemaSkew
	// FailureAdmissionRejected — the control plane ANSWERED and refused the CR
	// on its merits (webhook denial, or CRD schema/CEL). The webhook is up and
	// the CRD understands the payload; the spec is invalid.
	FailureAdmissionRejected
)

// String renders the diagnosis for test output and failure messages.
func (f ApplyFailure) String() string {
	switch f {
	case FailureWebhookDown:
		return "WEBHOOK-DOWN (deploys frozen, fail-closed)"
	case FailureSchemaSkew:
		return "SCHEMA-SKEW (CLI emits what this CRD does not know)"
	case FailureAdmissionRejected:
		return "ADMISSION-REJECTED (control plane answered; the CR is invalid)"
	default:
		return "UNRELATED (not a knext control-plane failure)"
	}
}

// Remediation is the action that actually fixes each class. The split exists
// because the wrong one is worse than none: downgrading a CLI during a webhook
// outage costs a release cycle and fixes nothing.
func (f ApplyFailure) Remediation() string {
	switch f {
	case FailureWebhookDown:
		return "restore the operator's validating webhook (check the controller-manager " +
			"Deployment, its webhook Service endpoints, and the serving certificate); " +
			"deploys stay frozen until it answers again — this is fail-closed, not skew, " +
			"and no CLI version changes it"
	case FailureSchemaSkew:
		return "the cluster's CRD does not know a field this CLI emits — upgrade the " +
			"operator and its CRD FIRST, then the CLI (that order is load-bearing); " +
			"the webhook is not involved in this failure"
	case FailureAdmissionRejected:
		return "the control plane answered and refused the CR — fix the spec it named " +
			"(the webhook is healthy and the CRD understands the payload)"
	default:
		return "not a knext control-plane failure — check cluster connectivity, " +
			"kubeconfig context, and that the target namespace exists"
	}
}

// schemaSkewRe matches the failures the apiserver (or kubectl) decides BEFORE
// admission: strict/decode field validation and an unserved apiVersion. These
// are exactly the shapes a CLI-newer-than-CRD apply produces, and none of them
// can be caused by the webhook being down.
var schemaSkewRe = regexp.MustCompile(`(?s)` +
	`strict decoding error` + // server-side fieldValidation=Strict
	`|unknown field` + // client- or server-side field validation
	`|no matches for kind .* in version` + // apiVersion the cluster does not serve
	`|the server (?:could not find the requested resource|doesn't have a resource type)`)

// admissionAnsweredRe matches a control plane that ANSWERED and said no: an
// explicit webhook denial or a schema/CEL "is invalid". Kept separate from
// webhookAnsweredRe (webhook.go), which serves the readiness probe's
// retry-vs-fail-fast decision rather than diagnosis.
var admissionAnsweredRe = regexp.MustCompile(`denied the request|is invalid:`)

// DiagnoseApplyFailure classifies the error output of a failed NextApp apply.
// Pure and unit-tested (diagnose_test.go); the webhook-down e2e delegates to it
// so the cluster assertions and the diagnosis can never drift apart.
func DiagnoseApplyFailure(msg string) ApplyFailure {
	switch {
	case msg == "":
		return FailureUnrelated
	// Skew FIRST — see the precedence note in this file's header.
	case schemaSkewRe.MatchString(msg):
		return FailureSchemaSkew
	// Reused from webhook.go: gated on the "failed calling webhook" marker, so
	// a bare apiserver "connection refused" deliberately does not match.
	case webhookUnreachableRe.MatchString(msg):
		return FailureWebhookDown
	case admissionAnsweredRe.MatchString(msg):
		return FailureAdmissionRejected
	default:
		return FailureUnrelated
	}
}
