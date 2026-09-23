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

import "testing"

// ParseCurlStatusMarker underpins both the GET (ActivateAndGet) and the
// Profile-A POST (HTTPPostInCluster) in-cluster probes: it must extract the
// HTTP code and body from curl's KNHTTP<code>KNEND marker even when kubectl's
// `--rm` merges its own `pod deleted` stderr notice into the output. These are
// untagged so they run under a plain `go test ./...` on every PR.
func TestParseCurlStatusMarkerHappy(t *testing.T) {
	raw := "<h1>File Manager</h1>\nKNHTTP200KNEND\npod \"post-x\" deleted"
	code, body, err := ParseCurlStatusMarker(raw, "http://example")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 200 {
		t.Fatalf("expected status 200, got %d", code)
	}
	if body != "<h1>File Manager</h1>" {
		t.Fatalf("body not cleanly separated from the marker: %q", body)
	}
}

func TestParseCurlStatusMarker401(t *testing.T) {
	raw := "{\"error\":\"Unauthorized\"}\nKNHTTP401KNEND"
	code, _, err := ParseCurlStatusMarker(raw, "http://example")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 401 {
		t.Fatalf("expected status 401, got %d", code)
	}
}

func TestParseCurlStatusMarkerNoMarker(t *testing.T) {
	if _, _, err := ParseCurlStatusMarker("no marker at all", "http://example"); err == nil {
		t.Fatalf("expected an error when the status marker is absent")
	}
}
