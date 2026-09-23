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

// Pure Profile-A helpers (issue #1202): the marker/timestamp/parse logic the
// scale-to-zero suite uses to prove the WOKEN file-manager pod actually serves
// the real app — not just that a pod came up. Kept UNTAGGED (no e2e_scale build
// tag) and free of cluster dependencies so it compiles and is mutation-proved by
// scale_profile_a_helpers_test.go under a plain `go test ./...` on every PR.
package e2e

import (
	"regexp"
	"strings"
)

// homePageMarker is a stable string emitted verbatim by the file-manager App
// Router home page (apps/file-manager/src/app/page.tsx). It is part of the
// static page shell — present regardless of DB availability — so its presence
// proves the woken pod rendered the real `/` route, not an activator/ingress
// error page. It is NOT invented here: change page.tsx and this constant must
// move with it.
const homePageMarker = "Powered by Knative + Next.js"

// onDemandPageMarker is the stable heading of the file-manager
// `/cache-tests/on-demand` route (apps/file-manager/src/app/cache-tests/on-demand/page.tsx),
// a `force-dynamic` server-rendered route. Serving it proves the woken pod runs
// SSR per request, and it is the exact page whose tag-cached data the ISR
// assertion busts.
const onDemandPageMarker = "On-Demand Revalidation"

// productsGeneratedAtClass is the Tailwind class on the span wrapping the
// PRODUCTS card's `generatedAt` timestamp on the on-demand page. That value is
// produced by an unstable_cache keyed with the `products` tag, so it only
// changes after revalidateTag('products') — unlike the page-level renderTime
// (text-gray-300), which changes on every force-dynamic render. Extracting the
// products timestamp specifically is what lets the ISR assertion prove the
// invalidation took effect rather than merely that the page re-rendered.
const productsGeneratedAtClass = "text-green-300"

// ordersGeneratedAtClass is the Tailwind class on the ORDERS card's generatedAt
// span. Orders is cached under the `orders` tag ONLY (never `products`), so an
// invalidation of the `products` tag must leave it UNCHANGED. It is the control
// in the ISR assertion: a pod recycle would refresh every card's generatedAt,
// so orders-unchanged is what distinguishes "revalidateTag('products') worked"
// from "the pod idled to zero and a fresh pod re-rendered everything". Do NOT
// use the summary card (text-purple-300) for this — summary carries BOTH tags,
// so a products invalidation legitimately changes it and it cannot be a control.
const ordersGeneratedAtClass = "text-blue-300"

// bodyServesHomePage reports whether an HTTP response body is the rendered
// file-manager home page (carries homePageMarker). An error page — a 502 body,
// an activator timeout page — will not.
func bodyServesHomePage(html string) bool {
	return strings.Contains(html, homePageMarker)
}

// isoTimestamp matches an ISO-8601 timestamp with millisecond precision and a
// trailing Z, exactly as `new Date().toISOString()` renders it.
const isoTimestamp = `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z`

// extractGeneratedAt pulls the ISO timestamp out of the first span whose class
// attribute contains colorClass. Returns (ts, true) on a match, ("", false)
// when the target span is absent. Used to read the products card's cached
// generatedAt so the ISR assertion can compare it across an invalidation.
func extractGeneratedAt(html, colorClass string) (string, bool) {
	re := regexp.MustCompile(regexp.QuoteMeta(colorClass) + `[^>]*>\s*(` + isoTimestamp + `)`)
	m := re.FindStringSubmatch(html)
	if len(m) < 2 {
		return "", false
	}
	return m[1], true
}
