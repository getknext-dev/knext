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

package controller

import (
	"regexp"
	"strings"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// rfc1123Label mirrors the AppDatabase CRD's appName pattern (must stay in
// lock-step with deploy/82-appdb-crd.yaml). deriveAppName MUST always produce a
// value matching this — an invalid derivation would be rejected at admission.
var rfc1123Label = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

func TestDeriveAppName_BasicNamespaceQualified(t *testing.T) {
	got := deriveAppName("team-acme", "shop")
	if got != "team-acme-shop" {
		t.Fatalf("deriveAppName = %q, want team-acme-shop", got)
	}
	if !rfc1123Label.MatchString(got) {
		t.Fatalf("derived appName %q does not match the AppDatabase RFC1123 pattern", got)
	}
}

// TestDeriveAppName_IsTheSecuritySeam is the crux of ADR-0006 §4.4: the appName
// is derived from the NextApp's OWN (namespace, name), so two apps that share a
// name but live in different namespaces get DIFFERENT database identities — a
// NextApp in ns A can never derive (and therefore never bind) ns B's DB.
func TestDeriveAppName_IsTheSecuritySeam(t *testing.T) {
	a := deriveAppName("tenant-a", "shop")
	b := deriveAppName("tenant-b", "shop")
	if a == b {
		t.Fatalf("cross-namespace isolation broken: ns A and ns B both derived %q — a NextApp could bind another namespace's DB", a)
	}
	if a != "tenant-a-shop" || b != "tenant-b-shop" {
		t.Fatalf("unexpected derivations: a=%q b=%q", a, b)
	}
}

func TestDeriveAppName_Deterministic(t *testing.T) {
	// Same identity → same appName, always (stored on status, must be stable).
	for i := 0; i < 5; i++ {
		if got := deriveAppName("team-acme", "shop"); got != "team-acme-shop" {
			t.Fatalf("non-deterministic derivation: got %q", got)
		}
	}
	// A long identity that overflows must ALSO be deterministic.
	long := strings.Repeat("x", 40)
	first := deriveAppName("really-long-namespace-name", long)
	second := deriveAppName("really-long-namespace-name", long)
	if first != second {
		t.Fatalf("overflow derivation not deterministic: %q != %q", first, second)
	}
}

func TestDeriveAppName_OverflowUsesHashAndStaysValid(t *testing.T) {
	// >63 raw chars must be truncated + hash-suffixed, staying ≤63 and RFC1123.
	ns := "a-very-long-namespace-that-eats-a-lot-of-the-budget"
	name := "and-an-equally-long-application-name-here-too"
	got := deriveAppName(ns, name)
	if len(got) > 63 {
		t.Fatalf("derived appName %q is %d chars, exceeds RFC1123 max of 63", got, len(got))
	}
	if !rfc1123Label.MatchString(got) {
		t.Fatalf("overflow derived appName %q does not match RFC1123 pattern", got)
	}
	// Two distinct long identities that share a truncation prefix must differ.
	other := deriveAppName(ns, name+"-variant")
	if got == other {
		t.Fatalf("distinct long identities collided on %q — hash must disambiguate", got)
	}
}

func TestDeriveAppName_SanitizesInvalidChars(t *testing.T) {
	// NextApp names can contain dots (DNS subdomain); namespaces are labels. Any
	// char outside the RFC1123 label set must be coerced so the result is valid.
	got := deriveAppName("Team.ACME", "My_App.v2")
	if !rfc1123Label.MatchString(got) {
		t.Fatalf("sanitized appName %q does not match RFC1123 pattern", got)
	}
	if strings.ContainsAny(got, "._ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
		t.Fatalf("sanitized appName %q still contains invalid/uppercase chars", got)
	}
}

func TestDeriveAppName_NeverReserved(t *testing.T) {
	// scale-zero-pg reserves tmpl/warm/ro. The derivation must never produce them.
	for _, r := range []string{"tmpl", "warm", "ro"} {
		if isReservedAppName(deriveAppName(r, r)) {
			t.Fatalf("derivation produced reserved appName for identity %q/%q", r, r)
		}
	}
}

// TestBuildAppDatabaseSpec_SurfacesAuthorSubset asserts the AppDatabase spec the
// operator renders carries the DERIVED appName (never user input) plus the
// author-relevant knobs, and requests the RO pool only when readReplicas is set.
func TestBuildAppDatabaseSpec_SurfacesAuthorSubset(t *testing.T) {
	app := &appsv1alpha1.NextApp{}
	app.Namespace = "team-acme"
	app.Name = "shop"
	app.Spec.Database = &appsv1alpha1.DatabaseSpec{
		Enabled:      true,
		Tier:         "warm",
		ReadReplicas: true,
		KeepOnDelete: true,
		Quotas:       &appsv1alpha1.DatabaseQuotas{CPU: "2000m", MaxConnections: 200},
	}
	appName := deriveAppName(app.Namespace, app.Name)
	spec := buildAppDatabaseSpec(app, appName)

	if spec["appName"] != appName {
		t.Errorf("spec.appName = %v, want derived %q", spec["appName"], appName)
	}
	if spec["appName"] == "shop" {
		t.Errorf("spec.appName must be the DERIVED (ns-qualified) name, not the raw NextApp name")
	}
	if spec["tier"] != "warm" {
		t.Errorf("spec.tier = %v, want warm", spec["tier"])
	}
	if spec["keepTimelineOnDelete"] != true {
		t.Errorf("spec.keepTimelineOnDelete = %v, want true", spec["keepTimelineOnDelete"])
	}
	ro, ok := spec["roPool"].(map[string]interface{})
	if !ok || ro["enabled"] != true {
		t.Errorf("spec.roPool.enabled not set when readReplicas=true: %v", spec["roPool"])
	}
	q, ok := spec["quotas"].(map[string]interface{})
	if !ok {
		t.Fatalf("spec.quotas missing")
	}
	if q["cpu"] != "2000m" {
		t.Errorf("spec.quotas.cpu = %v, want 2000m", q["cpu"])
	}
	if q["maxConnections"] != int64(200) {
		t.Errorf("spec.quotas.maxConnections = %v (%T), want int64(200)", q["maxConnections"], q["maxConnections"])
	}
}

func TestBuildAppDatabaseSpec_NoROPoolByDefault(t *testing.T) {
	app := &appsv1alpha1.NextApp{}
	app.Namespace = "default"
	app.Name = "blog"
	app.Spec.Database = &appsv1alpha1.DatabaseSpec{Enabled: true}
	spec := buildAppDatabaseSpec(app, deriveAppName("default", "blog"))
	if _, ok := spec["roPool"]; ok {
		t.Errorf("spec.roPool should be absent when readReplicas is false, got %v", spec["roPool"])
	}
}

// TestInjectDatabaseEnv wires DATABASE_URL (and _RO only when requested) into the
// in-memory envMap, reusing the existing SecretKeyRef path.
func TestInjectDatabaseEnv(t *testing.T) {
	app := &appsv1alpha1.NextApp{}
	injectDatabaseEnv(app, databaseWiring{ready: true, secretName: "shop-db", injectRO: true})
	em := app.Spec.Secrets.EnvMap
	if em["DATABASE_URL"].SecretName != "shop-db" || em["DATABASE_URL"].SecretKey != "DATABASE_URL" {
		t.Errorf("DATABASE_URL not injected correctly: %+v", em["DATABASE_URL"])
	}
	if em["DATABASE_URL_RO"].SecretName != "shop-db" {
		t.Errorf("DATABASE_URL_RO not injected when injectRO=true: %+v", em["DATABASE_URL_RO"])
	}

	app2 := &appsv1alpha1.NextApp{}
	injectDatabaseEnv(app2, databaseWiring{ready: true, secretName: "blog-db", injectRO: false})
	if _, ok := app2.Spec.Secrets.EnvMap["DATABASE_URL_RO"]; ok {
		t.Errorf("DATABASE_URL_RO must NOT be injected when injectRO=false")
	}
}
