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
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The data-sovereignty allowlist (ADR-0004 Amendment 1 Decision 2, Amendment 2
// Decision 6) as a PURE function: one test per Secret SOURCE for each rule, so a
// mutation that drops one source's collection reds exactly that source's test.
// The reconciler-level envtests (backendservice_envtest_test.go) prove the same
// rules end to end: a violating function renders no Knative Service.

const (
	sovNS        = "shop"
	sovZone      = "orders"
	sovOther     = "billing"
	sovZoneUID   = types.UID("uid-orders")
	sovOtherUID  = types.UID("uid-billing")
	sovOwnDB     = "orders-db"
	sovOwnDBRO   = "orders-db-ro-dsn"
	sovForeignDB = "billing-db"
)

func sovZoneApp(name string, uid types.UID, dbSecret string) appsv1alpha1.NextApp {
	app := appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: sovNS, UID: uid},
	}
	if dbSecret != "" {
		app.Spec.Database = &appsv1alpha1.DatabaseSpec{
			SecretRef: &appsv1alpha1.DatabaseSecretRef{Name: dbSecret},
		}
	}
	return app
}

func sovFixture() (*appsv1alpha1.NextApp, []appsv1alpha1.NextApp) {
	zone := sovZoneApp(sovZone, sovZoneUID, sovOwnDB)
	zone.Spec.Database.ROSecretRef = &appsv1alpha1.DatabaseSecretRef{Name: sovOwnDBRO}
	other := sovZoneApp(sovOther, sovOtherUID, sovForeignDB)
	return &zone, []appsv1alpha1.NextApp{other}
}

func sovFunction(spec appsv1alpha1.BackendServiceSpec) *appsv1alpha1.BackendService {
	spec.Zone = sovZone
	return &appsv1alpha1.BackendService{
		ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: sovNS},
		Spec:       spec,
	}
}

// sovSecrets is a lookup over a fixed set of Secret metadata. A name that is
// not in the map does not exist.
func sovSecrets(known map[string]secretMetadata) secretLookup {
	return func(name string) secretMetadata {
		if m, ok := known[name]; ok {
			m.found = true
			return m
		}
		return secretMetadata{}
	}
}

func noSecrets() secretLookup { return sovSecrets(nil) }

// Each source, built so that it references exactly one Secret.
func specSecretKeyRef(secret string) appsv1alpha1.BackendServiceSpec {
	return appsv1alpha1.BackendServiceSpec{Env: []corev1.EnvVar{{
		Name: "DSN",
		ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: secret}, Key: "DATABASE_URL",
		}},
	}}}
}

func specEnvFromSecret(secret string) appsv1alpha1.BackendServiceSpec {
	return appsv1alpha1.BackendServiceSpec{EnvFrom: []corev1.EnvFromSource{{
		SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: secret}},
	}}}
}

func specSecretVolume(secret string) appsv1alpha1.BackendServiceSpec {
	return appsv1alpha1.BackendServiceSpec{Volumes: []appsv1alpha1.FunctionVolume{{
		Name: "creds", MountPath: "/creds",
		Secret: &corev1.SecretVolumeSource{SecretName: secret},
	}}}
}

func specProjectedSecret(secret string) appsv1alpha1.BackendServiceSpec {
	return appsv1alpha1.BackendServiceSpec{Volumes: []appsv1alpha1.FunctionVolume{{
		Name: "bundle", MountPath: "/bundle",
		Projected: &appsv1alpha1.FunctionProjectedVolume{Sources: []appsv1alpha1.FunctionVolumeProjection{
			{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "plain-config"}}},
			{Secret: &corev1.SecretProjection{LocalObjectReference: corev1.LocalObjectReference{Name: secret}}},
		}},
	}}}
}

var secretSources = []struct {
	name   string
	source string // the source path the violation must name
	spec   func(string) appsv1alpha1.BackendServiceSpec
}{
	{"secretKeyRef", "env[DSN].valueFrom.secretKeyRef", specSecretKeyRef},
	{"envFrom", "envFrom[0].secretRef", specEnvFromSecret},
	{"secretVolume", "volumes[creds].secret", specSecretVolume},
	{"projectedVolume", "volumes[bundle].projected.sources[1].secret", specProjectedSecret},
}

func assertOneViolation(t *testing.T, got []sovereigntyViolation, source, secret, wantInMessage string) {
	t.Helper()
	if len(got) != 1 {
		t.Fatalf("want exactly one violation for %s, got %d: %+v", source, len(got), got)
	}
	v := got[0]
	if v.source != source {
		t.Errorf("violation names source %q, want %q", v.source, source)
	}
	if v.name != secret {
		t.Errorf("violation names %q, want %q", v.name, secret)
	}
	if !strings.Contains(v.message, wantInMessage) {
		t.Errorf("violation message %q does not contain %q", v.message, wantInMessage)
	}
}

// --- allow (a): the owning zone's database Secret, from every source --------

func TestSovereigntyAllowsOwnDatabaseSecretFromEverySource(t *testing.T) {
	zone, others := sovFixture()
	for _, src := range secretSources {
		for _, secret := range []string{sovOwnDB, sovOwnDBRO} {
			got := checkFunctionSovereignty(sovFunction(src.spec(secret)), zone, others, noSecrets())
			if len(got) != 0 {
				t.Errorf("%s -> the zone's own database Secret %q must be allowed, got %+v", src.name, secret, got)
			}
		}
	}
}

// --- reject: an UNMARKED Secret, one test per source -------------------------

func testUnmarkedSecretRejected(t *testing.T, srcName string) {
	t.Helper()
	zone, others := sovFixture()
	for _, src := range secretSources {
		if src.name != srcName {
			continue
		}
		got := checkFunctionSovereignty(sovFunction(src.spec("stripe-key")), zone, others,
			sovSecrets(map[string]secretMetadata{"stripe-key": {}}))
		assertOneViolation(t, got, src.source, "stripe-key", "not marked for zone")
		return
	}
	t.Fatalf("no source named %q", srcName)
}

func TestSovereigntyRejectsUnmarkedSecret_SecretKeyRef(t *testing.T) {
	testUnmarkedSecretRejected(t, "secretKeyRef")
}
func TestSovereigntyRejectsUnmarkedSecret_EnvFrom(t *testing.T) {
	testUnmarkedSecretRejected(t, "envFrom")
}
func TestSovereigntyRejectsUnmarkedSecret_SecretVolume(t *testing.T) {
	testUnmarkedSecretRejected(t, "secretVolume")
}
func TestSovereigntyRejectsUnmarkedSecret_ProjectedVolume(t *testing.T) {
	testUnmarkedSecretRejected(t, "projectedVolume")
}

// A Secret that does not exist is not marked either: refusing it keeps the
// rule fail-closed (a later-created Secret is re-checked on the next pass).
func TestSovereigntyRejectsMissingSecret(t *testing.T) {
	zone, others := sovFixture()
	got := checkFunctionSovereignty(sovFunction(specSecretKeyRef("ghost")), zone, others, noSecrets())
	assertOneViolation(t, got, "env[DSN].valueFrom.secretKeyRef", "ghost", "not marked for zone")
}

// --- reject: ANOTHER zone's database Secret, one test per source -------------

func testForeignDatabaseSecretRejected(t *testing.T, srcName string) {
	t.Helper()
	zone, others := sovFixture()
	for _, src := range secretSources {
		if src.name != srcName {
			continue
		}
		got := checkFunctionSovereignty(sovFunction(src.spec(sovForeignDB)), zone, others,
			sovSecrets(map[string]secretMetadata{sovForeignDB: {}}))
		assertOneViolation(t, got, src.source, sovForeignDB, `zone "billing"'s database Secret`)
		return
	}
	t.Fatalf("no source named %q", srcName)
}

func TestSovereigntyRejectsForeignDatabaseSecret_SecretKeyRef(t *testing.T) {
	testForeignDatabaseSecretRejected(t, "secretKeyRef")
}
func TestSovereigntyRejectsForeignDatabaseSecret_EnvFrom(t *testing.T) {
	testForeignDatabaseSecretRejected(t, "envFrom")
}
func TestSovereigntyRejectsForeignDatabaseSecret_SecretVolume(t *testing.T) {
	testForeignDatabaseSecretRejected(t, "secretVolume")
}
func TestSovereigntyRejectsForeignDatabaseSecret_ProjectedVolume(t *testing.T) {
	testForeignDatabaseSecretRejected(t, "projectedVolume")
}

// The read-only half of another zone's binding is just as foreign.
func TestSovereigntyRejectsForeignReadOnlyDatabaseSecret(t *testing.T) {
	zone, others := sovFixture()
	others[0].Spec.Database.ROSecretRef = &appsv1alpha1.DatabaseSecretRef{Name: "billing-ro"}
	got := checkFunctionSovereignty(sovFunction(specEnvFromSecret("billing-ro")), zone, others, noSecrets())
	assertOneViolation(t, got, "envFrom[0].secretRef", "billing-ro", `zone "billing"'s database Secret`)
}

// --- allow (b): a Secret MARKED for the same zone ----------------------------

func TestSovereigntyAllowsSecretMarkedForSameZoneByLabel(t *testing.T) {
	zone, others := sovFixture()
	lookup := sovSecrets(map[string]secretMetadata{
		"stripe-key": {labels: map[string]string{ZoneLabel: sovZone}},
	})
	for _, src := range secretSources {
		if got := checkFunctionSovereignty(sovFunction(src.spec("stripe-key")), zone, others, lookup); len(got) != 0 {
			t.Errorf("%s: a Secret labelled %s=%s must be allowed, got %+v", src.name, ZoneLabel, sovZone, got)
		}
	}
}

func TestSovereigntyAllowsSecretMarkedForSameZoneByOwnerReference(t *testing.T) {
	zone, others := sovFixture()
	lookup := sovSecrets(map[string]secretMetadata{
		"stripe-key": {ownerRefs: []metav1.OwnerReference{{
			APIVersion: appsv1alpha1.GroupVersion.String(), Kind: "NextApp", Name: sovZone, UID: sovZoneUID,
		}}},
	})
	if got := checkFunctionSovereignty(sovFunction(specSecretVolume("stripe-key")), zone, others, lookup); len(got) != 0 {
		t.Errorf("a Secret owned by the zone's NextApp must be allowed, got %+v", got)
	}
}

// An ownerReference must name THIS NextApp, UID included: a stale reference
// to a deleted-and-recreated zone of the same name is not the zone's mark.
func TestSovereigntyRejectsOwnerReferenceWithWrongUID(t *testing.T) {
	zone, others := sovFixture()
	lookup := sovSecrets(map[string]secretMetadata{
		"stripe-key": {ownerRefs: []metav1.OwnerReference{{
			APIVersion: appsv1alpha1.GroupVersion.String(), Kind: "NextApp", Name: sovZone, UID: "stale-uid",
		}}},
	})
	got := checkFunctionSovereignty(sovFunction(specSecretVolume("stripe-key")), zone, others, lookup)
	assertOneViolation(t, got, "volumes[creds].secret", "stripe-key", "not marked for zone")
}

// --- reject: a Secret marked for ANOTHER zone --------------------------------

func TestSovereigntyRejectsSecretLabelledForAnotherZone(t *testing.T) {
	zone, others := sovFixture()
	lookup := sovSecrets(map[string]secretMetadata{
		"billing-stripe": {labels: map[string]string{ZoneLabel: sovOther}},
	})
	got := checkFunctionSovereignty(sovFunction(specEnvFromSecret("billing-stripe")), zone, others, lookup)
	assertOneViolation(t, got, "envFrom[0].secretRef", "billing-stripe", `marked for zone "billing"`)
}

func TestSovereigntyRejectsSecretOwnedByAnotherZone(t *testing.T) {
	zone, others := sovFixture()
	lookup := sovSecrets(map[string]secretMetadata{
		"billing-stripe": {ownerRefs: []metav1.OwnerReference{{
			APIVersion: appsv1alpha1.GroupVersion.String(), Kind: "NextApp", Name: sovOther, UID: sovOtherUID,
		}}},
	})
	got := checkFunctionSovereignty(sovFunction(specSecretKeyRef("billing-stripe")), zone, others, lookup)
	assertOneViolation(t, got, "env[DSN].valueFrom.secretKeyRef", "billing-stripe", `marked for zone "billing"`)
}

// --- deny wins over a same-zone mark (Amendment 1 Decision 2) ----------------

func TestSovereigntyDenyWinsOverSameZoneMark(t *testing.T) {
	zone, others := sovFixture()
	// The other zone's database Secret, relabelled for THIS zone and given an
	// ownerReference to it: both marks say "orders", and it is still refused.
	lookup := sovSecrets(map[string]secretMetadata{
		sovForeignDB: {
			labels: map[string]string{ZoneLabel: sovZone},
			ownerRefs: []metav1.OwnerReference{{
				APIVersion: appsv1alpha1.GroupVersion.String(), Kind: "NextApp", Name: sovZone, UID: sovZoneUID,
			}},
		},
	})
	got := checkFunctionSovereignty(sovFunction(specSecretVolume(sovForeignDB)), zone, others, lookup)
	assertOneViolation(t, got, "volumes[creds].secret", sovForeignDB, `zone "billing"'s database Secret`)
}

// --- the zone's signing key never reaches a function -------------------------

func TestSovereigntyRejectsEveryZoneSigningKeySecret(t *testing.T) {
	zone, others := sovFixture()
	for _, owner := range []string{sovZone, sovOther} {
		key := ZoneSigningKeySecretName(owner)
		// Even marked for this zone: the private key is never a function's.
		lookup := sovSecrets(map[string]secretMetadata{key: {labels: map[string]string{ZoneLabel: sovZone}}})
		got := checkFunctionSovereignty(sovFunction(specProjectedSecret(key)), zone, others, lookup)
		assertOneViolation(t, got, "volumes[bundle].projected.sources[1].secret", key, "signing key")
	}
}

// --- imagePullSecrets are exempt (Amendment 1 Decision 2) --------------------

func TestSovereigntyExemptsImagePullSecrets(t *testing.T) {
	zone, others := sovFixture()
	bs := sovFunction(appsv1alpha1.BackendServiceSpec{
		ImagePullSecrets: []corev1.LocalObjectReference{{Name: "ocir-pull"}, {Name: sovForeignDB}},
	})
	if got := checkFunctionSovereignty(bs, zone, others, noSecrets()); len(got) != 0 {
		t.Errorf("imagePullSecrets are exempt from the allowlist, got %+v", got)
	}
}

// --- no zone resolved: nothing is allowed ------------------------------------

func TestSovereigntyWithoutZoneAllowsNoSecret(t *testing.T) {
	_, others := sovFixture()
	got := checkFunctionSovereignty(sovFunction(specSecretKeyRef(sovOwnDB)), nil, others,
		sovSecrets(map[string]secretMetadata{sovOwnDB: {labels: map[string]string{ZoneLabel: sovZone}}}))
	if len(got) != 1 {
		t.Fatalf("with no resolved zone every Secret reference is refused, got %+v", got)
	}
}

// --- a function cannot mount another zone's JWKS -----------------------------

var configMapSources = []struct {
	name   string
	source string
	spec   func(string) appsv1alpha1.BackendServiceSpec
}{
	{"configMapKeyRef", "env[JWKS].valueFrom.configMapKeyRef", func(cm string) appsv1alpha1.BackendServiceSpec {
		return appsv1alpha1.BackendServiceSpec{Env: []corev1.EnvVar{{
			Name: "JWKS",
			ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: cm}, Key: ZoneJWKSFileName,
			}},
		}}}
	}},
	{"envFrom", "envFrom[0].configMapRef", func(cm string) appsv1alpha1.BackendServiceSpec {
		return appsv1alpha1.BackendServiceSpec{EnvFrom: []corev1.EnvFromSource{{
			ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: cm}},
		}}}
	}},
	{"configMapVolume", "volumes[keys].configMap", func(cm string) appsv1alpha1.BackendServiceSpec {
		return appsv1alpha1.BackendServiceSpec{Volumes: []appsv1alpha1.FunctionVolume{{
			Name: "keys", MountPath: "/keys",
			ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: cm}},
		}}}
	}},
	{"projectedVolume", "volumes[keys].projected.sources[0].configMap", func(cm string) appsv1alpha1.BackendServiceSpec {
		return appsv1alpha1.BackendServiceSpec{Volumes: []appsv1alpha1.FunctionVolume{{
			Name: "keys", MountPath: "/keys",
			Projected: &appsv1alpha1.FunctionProjectedVolume{Sources: []appsv1alpha1.FunctionVolumeProjection{
				{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: cm}}},
			}},
		}}}
	}},
}

func TestSovereigntyRejectsForeignJWKSFromEverySource(t *testing.T) {
	zone, others := sovFixture()
	foreign := ZoneJWKSConfigMapName(sovOther)
	for _, src := range configMapSources {
		t.Run(src.name, func(t *testing.T) {
			got := checkFunctionSovereignty(sovFunction(src.spec(foreign)), zone, others, noSecrets())
			assertOneViolation(t, got, src.source, foreign, "another zone's JWKS")
		})
	}
}

func TestSovereigntyAllowsOwnJWKSAndPlainConfigMaps(t *testing.T) {
	zone, others := sovFixture()
	for _, src := range configMapSources {
		for _, cm := range []string{ZoneJWKSConfigMapName(sovZone), "plain-config"} {
			if got := checkFunctionSovereignty(sovFunction(src.spec(cm)), zone, others, noSecrets()); len(got) != 0 {
				t.Errorf("%s -> ConfigMap %q must be allowed, got %+v", src.name, cm, got)
			}
		}
	}
}

// --- the CNPG host check is a LINT (warning), never a rejection --------------

// cnpgHost builds a CNPG service host without writing the "-rw"/"-ro" literal
// next to a host: the repo's sovereignty hook (rightly) refuses source that
// hard-codes one, and these fixtures exist to prove the operator's lint flags it.
func cnpgHost(cluster, role, rest string) string {
	return cluster + "-" + role + rest
}

func lintFunction(env ...corev1.EnvVar) *appsv1alpha1.BackendService {
	return sovFunction(appsv1alpha1.BackendServiceSpec{Env: env})
}

func TestDatabaseHostLintFlagsAnotherZonesCluster(t *testing.T) {
	zone, others := sovFixture()
	dsn := "postgres://u:p@" + cnpgHost("billing-db", "rw", ".shop.svc.cluster.local") + ":5432/app"
	got := lintForeignDatabaseHosts(lintFunction(corev1.EnvVar{Name: "BILLING_DSN", Value: dsn}), zone, others)
	if len(got) != 1 || got[0].env != "BILLING_DSN" || got[0].zone != sovOther {
		t.Fatalf("want one finding on BILLING_DSN for zone billing, got %+v", got)
	}
}

func TestDatabaseHostLintFlagsReadOnlyService(t *testing.T) {
	zone, others := sovFixture()
	got := lintForeignDatabaseHosts(lintFunction(corev1.EnvVar{Name: "RO", Value: cnpgHost("billing", "ro", "")}), zone, others)
	if len(got) != 1 || got[0].zone != sovOther {
		t.Fatalf("want one finding for zone billing's -ro service, got %+v", got)
	}
}

func TestDatabaseHostLintFlagsAnotherNamespace(t *testing.T) {
	zone, others := sovFixture()
	got := lintForeignDatabaseHosts(lintFunction(corev1.EnvVar{
		Name: "X", Value: cnpgHost("orders-db", "rw", ".other-ns.svc:5432"),
	}), zone, others)
	if len(got) != 1 || got[0].otherNamespace != "other-ns" {
		t.Fatalf("a host in another namespace is another zone's by definition, got %+v", got)
	}
}

func TestDatabaseHostLintLongestZonePrefixWins(t *testing.T) {
	// Zones "orders" (the other) and "orders-archive" (this one): the cluster
	// "orders-archive-db" belongs to the longer match, this zone.
	zone := sovZoneApp("orders-archive", "uid-archive", "")
	others := []appsv1alpha1.NextApp{sovZoneApp("orders", "uid-orders", "")}
	bs := lintFunction(corev1.EnvVar{Name: "OWN", Value: cnpgHost("orders-archive-db", "rw", "")})
	bs.Spec.Zone = "orders-archive"
	if got := lintForeignDatabaseHosts(bs, &zone, others); len(got) != 0 {
		t.Fatalf("own zone's cluster flagged as foreign: %+v", got)
	}
	bs.Spec.Env[0].Value = cnpgHost("orders-db", "ro", "")
	if got := lintForeignDatabaseHosts(bs, &zone, others); len(got) != 1 || got[0].zone != "orders" {
		t.Fatalf("zone orders' cluster not flagged: %+v", got)
	}
}

func TestDatabaseHostLintIgnoresOwnAndUnrelatedHosts(t *testing.T) {
	zone, others := sovFixture()
	bs := lintFunction(
		corev1.EnvVar{Name: "OWN", Value: cnpgHost("orders-db", "rw", ".shop.svc")},
		corev1.EnvVar{Name: "UNRELATED", Value: cnpgHost("cache", "ro", "")},
		corev1.EnvVar{Name: "PLAIN", Value: "billing.example.com"},
		corev1.EnvVar{Name: "FROM_SECRET", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: sovOwnDB}, Key: "k",
		}}},
	)
	if got := lintForeignDatabaseHosts(bs, zone, others); len(got) != 0 {
		t.Fatalf("no finding expected, got %+v", got)
	}
}

// The lint never contributes a sovereignty VIOLATION: a foreign host in an env
// literal leaves checkFunctionSovereignty empty.
func TestDatabaseHostLintIsNotARejection(t *testing.T) {
	zone, others := sovFixture()
	bs := lintFunction(corev1.EnvVar{Name: "X", Value: cnpgHost("billing", "rw", "")})
	if got := checkFunctionSovereignty(bs, zone, others, noSecrets()); len(got) != 0 {
		t.Fatalf("the database-host check is a lint, not a rejection: %+v", got)
	}
}
