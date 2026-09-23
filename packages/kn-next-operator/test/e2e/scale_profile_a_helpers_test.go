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

// These tests are DELIBERATELY untagged (no e2e_scale build tag) so the pure
// Profile-A helpers — the woken-pod route marker and the ISR generatedAt
// extraction — are exercised and mutation-proved under a plain `go test ./...`
// on every PR, not only inside the nightly cluster suite. The helpers carry the
// security-relevant assertion logic (which page proves the real app rendered,
// which timestamp proves revalidation took effect), so they must be provable
// without standing up Knative.
package e2e

import "testing"

// A trimmed but faithful slice of the rendered `/cache-tests/on-demand` HTML:
// the products card's generatedAt lives in a text-green-300 span, orders in
// text-blue-300, and the page-level renderTime in text-gray-300. The extractor
// must pick the PRODUCTS timestamp (the one revalidateTag('products') busts),
// never the always-changing force-dynamic renderTime.
const onDemandSampleHTML = `
<h1>🎯 On-Demand Revalidation</h1>
<p>Generated: <span class="text-green-300 font-mono text-xs">2026-09-23T10:00:00.111Z</span></p>
<p>Generated: <span class="text-blue-300 font-mono text-xs">2026-09-23T10:00:00.222Z</span></p>
<p>Generated: <span class="text-purple-300 font-mono text-xs">2026-09-23T10:00:00.333Z</span></p>
<p>Page rendered at: <span class="text-gray-300 font-mono">2026-09-23T10:00:00.999Z</span></p>
`

const homeSampleHTML = `<h1>File Manager</h1><p>Powered by Knative + Next.js</p>`

func TestBodyServesHomePage(t *testing.T) {
	if !bodyServesHomePage(homeSampleHTML) {
		t.Fatalf("expected the home marker %q to be detected in the rendered home page", homePageMarker)
	}
	// An activator/ingress error page or a bare 502 body carries no marker.
	if bodyServesHomePage("<html><body>502 Bad Gateway</body></html>") {
		t.Fatalf("home marker must NOT match an error page that never rendered the app")
	}
}

func TestExtractGeneratedAtPicksProductsNotRenderTime(t *testing.T) {
	got, ok := extractGeneratedAt(onDemandSampleHTML, productsGeneratedAtClass)
	if !ok {
		t.Fatalf("expected to extract the products generatedAt timestamp")
	}
	// It must be the products (green) timestamp, NOT the page renderTime (gray),
	// which changes on every force-dynamic render and would falsely "prove"
	// invalidation.
	if got != "2026-09-23T10:00:00.111Z" {
		t.Fatalf("extracted wrong timestamp: got %q, want the products (green) timestamp", got)
	}
}

func TestExtractGeneratedAtPicksOrdersControl(t *testing.T) {
	// The ISR assertion's CONTROL: the orders (blue) timestamp must be extracted
	// distinctly from products (green). If ordersGeneratedAtClass ever pointed at
	// the wrong span, the "orders unchanged" control would compare the wrong value
	// and stop distinguishing invalidation from a pod recycle.
	got, ok := extractGeneratedAt(onDemandSampleHTML, ordersGeneratedAtClass)
	if !ok {
		t.Fatalf("expected to extract the orders generatedAt timestamp")
	}
	if got != "2026-09-23T10:00:00.222Z" {
		t.Fatalf("extracted wrong timestamp: got %q, want the orders (blue) timestamp", got)
	}
	// The control MUST be a different value from products, or it proves nothing.
	products, _ := extractGeneratedAt(onDemandSampleHTML, productsGeneratedAtClass)
	if got == products {
		t.Fatalf("orders control and products timestamps must be distinct spans; both were %q", got)
	}
}

func TestExtractGeneratedAtMissing(t *testing.T) {
	if _, ok := extractGeneratedAt("<p>no timestamps here</p>", productsGeneratedAtClass); ok {
		t.Fatalf("expected ok=false when the target span is absent")
	}
}
