package pswatcher

import (
	"regexp"
	"strings"
	"testing"
)

// The build_info capability gauge is the D9 running-binary signal: a scraper (the
// _verify-pswatcher-capability drill, and _validate.sh where it can reach the pod)
// reads the DEPLOYED binary's features rather than trusting a manifest env var that a
// STALE image would silently ignore. A pre-capability image, built before these
// feature entries existed, cannot emit them — so a stale 58-pswatcher.yaml image reds
// the drill instead of passing every source-pinned lockstep check.

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
