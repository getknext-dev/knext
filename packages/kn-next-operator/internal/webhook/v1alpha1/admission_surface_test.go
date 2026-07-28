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

package v1alpha1

// ADMISSION-SURFACE guard (#314, sprint 2 S11).
//
// Three assertions, each of which is a PREMISE of the webhook-down deploy-freeze
// e2e (test/e2e/webhook_down_freeze_test.go). If any of them stops holding, that
// e2e is measuring something other than what it claims, so they fail HERE — in
// the cheap, always-run unit lane — rather than being discovered as a confusing
// e2e result.
//
//  1. failurePolicy is Fail. This is the whole reason a webhook outage freezes
//     deploys. Flip it to Ignore and the freeze disappears (along with the
//     fail-closed guarantee).
//  2. There is NO mutating/defaulting webhook for NextApp. This is the one that
//     is easy to get wrong: a webhook-DEFAULTED field is absent when the webhook
//     is down, and an absent field reads exactly like a field the CRD does not
//     know — i.e. like SKEW. Today knext defaults nothing at admission, so that
//     confusion cannot arise. The day someone adds a defaulting webhook, this
//     goes red and DiagnoseApplyFailure must grow a fourth class before it lands.
//  3. The webhook is NOT scoped by a namespaceSelector or objectSelector. That
//     is a recorded anti-item: narrowing the admission surface to make an e2e
//     easier to write narrows the blast radius of a security control. This guard
//     makes the shortcut fail rather than pass silently.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// webhookManifestPath is the kubebuilder-generated ValidatingWebhookConfiguration
// that `make deploy` and the install bundle both render from.
func webhookManifestPath(t *testing.T) string {
	t.Helper()
	p := filepath.Join("..", "..", "..", "config", "webhook", "manifests.yaml")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("webhook manifest not found at %s: %v", p, err)
	}
	return p
}

func readWebhookManifest(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(webhookManifestPath(t))
	if err != nil {
		t.Fatalf("reading webhook manifest: %v", err)
	}
	return string(b)
}

// TestWebhookIsFailClosed pins the premise of the deploy-freeze e2e.
func TestWebhookIsFailClosed(t *testing.T) {
	manifest := readWebhookManifest(t)
	if !strings.Contains(manifest, "failurePolicy: Fail") {
		t.Fatal("the NextApp validating webhook must be failurePolicy: Fail — " +
			"the fail-closed guarantee (and the webhook-down deploy-freeze e2e) depends on it")
	}
	if strings.Contains(manifest, "failurePolicy: Ignore") {
		t.Fatal("a NextApp webhook is failurePolicy: Ignore — writes would be admitted " +
			"unvalidated whenever the operator is down")
	}
	// The Go marker is the source of truth kubebuilder renders from; assert it
	// too, so a manifest edited by hand cannot drift from the generator.
	src, err := os.ReadFile("nextapp_webhook.go")
	if err != nil {
		t.Fatalf("reading nextapp_webhook.go: %v", err)
	}
	if !strings.Contains(string(src), "failurePolicy=fail") {
		t.Fatal("the +kubebuilder:webhook marker must declare failurePolicy=fail")
	}
}

// TestNoDefaultingWebhook is the assertion that keeps webhook-down from being
// confusable with skew via a THIRD path: a defaulted field going missing.
func TestNoDefaultingWebhook(t *testing.T) {
	manifest := readWebhookManifest(t)
	if strings.Contains(manifest, "kind: MutatingWebhookConfiguration") {
		t.Fatal("a MutatingWebhookConfiguration exists for NextApp. A webhook-DEFAULTED field " +
			"is absent while the webhook is down, which reads exactly like a field the CRD " +
			"does not know — i.e. like skew. Before this lands, extend " +
			"utils.DiagnoseApplyFailure to separate 'defaulted field missing' from schema skew " +
			"and extend the webhook-down freeze e2e to assert it")
	}
	src, err := os.ReadFile("nextapp_webhook.go")
	if err != nil {
		t.Fatalf("reading nextapp_webhook.go: %v", err)
	}
	if !strings.Contains(string(src), "mutating=false") {
		t.Fatal("the +kubebuilder:webhook marker must declare mutating=false — knext defaults " +
			"nothing at admission, and the webhook-down diagnosis relies on that")
	}
	if strings.Contains(string(src), "WithDefaulter(") {
		t.Fatal("a defaulter is registered for NextApp — see the MutatingWebhookConfiguration " +
			"note above; the webhook-down diagnosis must be extended first")
	}
}

// TestWebhookIsNotSelectorScoped enforces the sprint's recorded anti-item.
func TestWebhookIsNotSelectorScoped(t *testing.T) {
	manifest := readWebhookManifest(t)
	for _, forbidden := range []string{"namespaceSelector", "objectSelector"} {
		if strings.Contains(manifest, forbidden) {
			t.Fatalf("the NextApp validating webhook declares a %s. Narrowing the admission "+
				"surface is a production security change, not a test convenience — if an "+
				"upgrade e2e is hard to write, that is a fact about the test (SPRINT_2 anti-item)",
				forbidden)
		}
	}
}
