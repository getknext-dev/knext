package pswatcher

import (
	"regexp"
	"strings"
	"testing"
)

// The build_info capability gauge is the D9 running-binary signal: the
// _verify-pswatcher-capability drill scrapes it off the live pod, so it reads the
// DEPLOYED binary's features rather than trusting a manifest env var that a STALE image
// would silently ignore. A pre-capability image, built before these feature entries
// existed, cannot emit them — so a stale 58-pswatcher.yaml image reds the drill instead
// of passing every source-pinned lockstep check. (_validate.sh never scrapes a pod; it
// greps metrics.go source, which is the BUILD-side half of the same contract.)

func TestBuildInfoGaugeExposesCapabilities(t *testing.T) {
	m := NewMetrics()
	out := m.PromText()

	// The gauge must be emitted unconditionally (value 1), before any failover.
	re := regexp.MustCompile(`(?m)^pswatcher_build_info\{([^}]*)\} 1$`)
	match := re.FindStringSubmatch(out)
	if match == nil {
		t.Fatalf("pswatcher_build_info{...} 1 not emitted by PromText:\n%s", out)
	}
	labels := match[1]

	// version label present (defaults to "dev" for an un-stamped build).
	if !regexp.MustCompile(`version="[^"]+"`).MatchString(labels) {
		t.Fatalf("pswatcher_build_info missing a non-empty version label: %q", labels)
	}

	// features label present and carrying BOTH shipped capabilities.
	fm := regexp.MustCompile(`features="([^"]*)"`).FindStringSubmatch(labels)
	if fm == nil {
		t.Fatalf("pswatcher_build_info missing a features label: %q", labels)
	}
	feats := strings.Split(fm[1], ",")
	want := map[string]bool{FeatureRoutedSet: false, FeatureFreeze: false}
	for _, f := range feats {
		if _, ok := want[f]; ok {
			want[f] = true
		}
	}
	for f, seen := range want {
		if !seen {
			t.Fatalf("pswatcher_build_info features=%q must include %q (D9 routed-set+freeze capability signal)", fm[1], f)
		}
	}
}

// The feature tokens are a WIRE contract, not an internal name: the drill's
// REQUIRE_FEATURES default and any future PromQL match on the literal strings. Every
// other assertion in this file keys its expectation off the constants themselves, so
// renaming a token to "potato" kept `go test` green and the literal was pinned only by
// deploy/_validate.sh — which no workflow runs. Assert the literals in the test CI does
// run; changing a token must be a deliberate, cross-artifact change.
func TestFeatureTokenWireValues(t *testing.T) {
	if FeatureRoutedSet != "routed-set" {
		t.Fatalf("FeatureRoutedSet wire token changed: got %q, want %q — _verify-pswatcher-capability.sh's REQUIRE_FEATURES default and deploy/_validate.sh both match this literal; a rename silently turns every current image into a false 'stale image' red", FeatureRoutedSet, "routed-set")
	}
	if FeatureFreeze != "freeze" {
		t.Fatalf("FeatureFreeze wire token changed: got %q, want %q — see the FeatureRoutedSet note; the token is scraped off the live pod, so it must stay stable across image generations", FeatureFreeze, "freeze")
	}
}

func TestFeaturesLabelMatchesConstants(t *testing.T) {
	got := FeaturesLabel()
	if !strings.Contains(got, FeatureRoutedSet) {
		t.Fatalf("FeaturesLabel()=%q must contain %q", got, FeatureRoutedSet)
	}
	if !strings.Contains(got, FeatureFreeze) {
		t.Fatalf("FeaturesLabel()=%q must contain %q", got, FeatureFreeze)
	}
}

func TestBuildVersionDefault(t *testing.T) {
	if BuildVersion == "" {
		t.Fatal("BuildVersion must never be empty (defaults to \"dev\" so pswatcher_build_info always carries a version label)")
	}
}
