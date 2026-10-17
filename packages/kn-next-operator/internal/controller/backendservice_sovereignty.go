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
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Data sovereignty for zone functions (ADR-0004 Amendment 1 Decision 2,
// Amendment 2 Decision 6).
//
// THE CONTROL is the credential allowlist below: a function holds no
// credential for another zone's database. Three things together make that
// hold: this allowlist, applied only through a two-sided binding, and enforced
// against the API by the operator-owned ServiceAccount (no Role, no
// RoleBinding, automount off).
//
// The database-HOST check further down is a LINT. It catches a mistake (an env
// literal naming another zone's CNPG service), but an IP address, an
// ExternalName Service or a URL built at run time gets past any string match,
// so it is reported as a warning and never rejects anything.
//
// Everything here is PURE: the reconciler supplies the Secret metadata through
// a lookup, so every rule is unit-testable and mutation-provable per source.

const (
	// ZoneLabel marks a Secret as belonging to a zone (value: the zone's
	// NextApp name). A function may reference a Secret carrying this label for
	// its own zone. Anyone who can write Secrets in the namespace can set it:
	// the namespace is the trust boundary, and the mark only closes the
	// confused-deputy path (a BackendService author who cannot read a Secret
	// getting the operator to mount it).
	ZoneLabel = "apps.kn-next.dev/zone"

	// FunctionLabel names the BackendService on the objects rendered for it.
	FunctionLabel = "apps.kn-next.dev/function"

	// ZoneJWKSFileName is the key inside a zone's JWKS ConfigMap, and the file
	// name the function's verifier reads.
	ZoneJWKSFileName = "jwks.json"

	// ZoneJWKSMountDir is where every function mounts its owning zone's JWKS
	// (a directory volume, never a subPath, so ConfigMap updates propagate).
	// The zone-function templates read ZoneJWKSMountDir/ZoneJWKSFileName.
	ZoneJWKSMountDir = "/var/run/knext/jwks"

	zoneJWKSConfigMapSuffix    = "-knext-jwks"
	zoneSigningKeySecretSuffix = "-knext-signing-key"
)

// ZoneJWKSConfigMapName is the ConfigMap holding a zone's public keys. The
// identity task (Z7) creates it; until it exists the function's mount is
// optional and its interceptor refuses every RPC except health.
func ZoneJWKSConfigMapName(zone string) string { return zone + zoneJWKSConfigMapSuffix }

// zoneJWKSState is what the BackendService reconciler found at the zone's JWKS
// ConfigMap name.
type zoneJWKSState int

const (
	// zoneJWKSAbsent: no such ConfigMap yet (the zero value). The mount stays
	// optional: the NextApp reconciler creates the ConfigMap and the kubelet
	// fills the volume without a new revision.
	zoneJWKSAbsent zoneJWKSState = iota
	// zoneJWKSControlled: the zone's NextApp is the ConfigMap's controller (by
	// UID), so the keys in it are the zone's own.
	zoneJWKSControlled
	// zoneJWKSUntrusted: the ConfigMap exists and the zone does not control it
	// (a squatter, or an object left by an earlier NextApp of the same name).
	// It is NOT mounted: the function has no key set and refuses every call
	// except health (fail closed).
	zoneJWKSUntrusted
)

// classifyZoneJWKS decides whether the ConfigMap found at the zone's JWKS name
// (nil: none) may be mounted into the zone's functions. It trusts the object
// only when the zone's NextApp is its CONTROLLER by UID: a name match is not
// enough (an earlier NextApp of the same name leaves an object with another
// UID), nor is an owner that is not the controller. It is the same test the
// NextApp reconciler applies before it writes the ConfigMap
// (controlledByZone), so the two halves agree on who controls the object.
//
// For an untrusted object the second result says why, for the status message.
//
// An ownerReference is a claim anyone who can write the ConfigMap can make
// (the zone's UID is readable): this check closes an accidental or early
// squat and a stale object, not a deliberate forger. The namespace remains
// the trust boundary (docs/security/threat-model.md).
func classifyZoneJWKS(cm *metav1.PartialObjectMetadata, zone *appsv1alpha1.NextApp) (zoneJWKSState, string) {
	if cm == nil {
		return zoneJWKSAbsent, ""
	}
	if controlledByZone(cm, zone) {
		return zoneJWKSControlled, ""
	}
	ref := metav1.GetControllerOf(cm)
	switch {
	case ref == nil:
		return zoneJWKSUntrusted, "it has no controller ownerReference"
	case ownerReferencesNextApp(*ref) && ref.Name == zone.Name:
		return zoneJWKSUntrusted, fmt.Sprintf("its controller is a NextApp named %q with a different UID "+
			"(left by an earlier NextApp of that name?)", ref.Name)
	default:
		return zoneJWKSUntrusted, fmt.Sprintf("its controller is %s %q, not the zone", ref.Kind, ref.Name)
	}
}

// ZoneSigningKeySecretName is the Secret holding a zone's private signing key.
// The identity task (Z7) creates it and mounts it into the zone only; no
// function may reference ANY zone's signing key, its own included.
func ZoneSigningKeySecretName(zone string) string { return zone + zoneSigningKeySecretSuffix }

// secretMetadata is what the allowlist needs to know about one Secret. found is
// false when the Secret does not exist (it is then unmarked).
type secretMetadata struct {
	found     bool
	labels    map[string]string
	ownerRefs []metav1.OwnerReference
	// readErr is set when the metadata could not be read (not NotFound). That is
	// NOT an answer about the Secret's marks (a timeout, a 429, a 5xx, a missing
	// grant say nothing about them), so it is never a violation: the Secret is
	// reported as unverified and the reconcile errors and requeues, leaving what
	// was rendered (#2498). Only a definitive answer (NotFound, or an object with
	// the wrong owner or labels) refuses a function.
	readErr string
	// denied marks a readErr that is an authorization failure (Forbidden or
	// Unauthorized): held like any unknown answer, but only for a bounded window
	// (secretsDeniedHold) counted from the first denial, because a lost grant
	// would otherwise freeze revocation for every function.
	//
	// There is deliberately no "rejected" state: a failed read is NEVER a
	// definitive answer. The only definitive answers are NotFound and the marks
	// of an object that was read; a name no Secret can have is refused before any
	// read (secretNameProblem). An error the owner can provoke must never mean
	// teardown, and an error nobody anticipated must never either.
	denied bool
}

// unverifiedSecret is a referenced Secret whose metadata could not be read, so
// its marks are unknown. It is not a violation.
type unverifiedSecret struct {
	source string
	name   string
	err    string
	// denied: the read was refused for lack of permission (see secretMetadata).
	denied bool
}

// secretLookup returns the metadata of a Secret in the function's namespace.
type secretLookup func(name string) secretMetadata

// objectRef is one reference from the function's spec to a Secret or a
// ConfigMap, with the source path a status message names.
type objectRef struct {
	source string
	name   string
}

// sovereigntyViolation is one refused reference.
type sovereigntyViolation struct {
	source  string
	name    string
	message string
}

func (v sovereigntyViolation) String() string {
	return fmt.Sprintf("%s: %s", v.source, v.message)
}

// functionSecretRefs lists every Secret the function's spec references, from
// every source the pod could read it through. imagePullSecrets are exempt from
// the allowlist (a private registry needs them and they expose no data store),
// so they are deliberately not collected.
func functionSecretRefs(spec *appsv1alpha1.BackendServiceSpec) []objectRef {
	var refs []objectRef
	for _, e := range spec.Env {
		if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
			refs = append(refs, objectRef{fmt.Sprintf("env[%s].valueFrom.secretKeyRef", e.Name), e.ValueFrom.SecretKeyRef.Name})
		}
	}
	for i, ef := range spec.EnvFrom {
		if ef.SecretRef != nil {
			refs = append(refs, objectRef{fmt.Sprintf("envFrom[%d].secretRef", i), ef.SecretRef.Name})
		}
	}
	for _, v := range spec.Volumes {
		if v.Secret != nil {
			refs = append(refs, objectRef{fmt.Sprintf("volumes[%s].secret", v.Name), v.Secret.SecretName})
		}
		if v.Projected != nil {
			for i, s := range v.Projected.Sources {
				if s.Secret != nil {
					refs = append(refs, objectRef{fmt.Sprintf("volumes[%s].projected.sources[%d].secret", v.Name, i), s.Secret.Name})
				}
			}
		}
	}
	return refs
}

// functionConfigMapRefs lists every ConfigMap the function's spec references.
func functionConfigMapRefs(spec *appsv1alpha1.BackendServiceSpec) []objectRef {
	var refs []objectRef
	for _, e := range spec.Env {
		if e.ValueFrom != nil && e.ValueFrom.ConfigMapKeyRef != nil {
			refs = append(refs, objectRef{fmt.Sprintf("env[%s].valueFrom.configMapKeyRef", e.Name), e.ValueFrom.ConfigMapKeyRef.Name})
		}
	}
	for i, ef := range spec.EnvFrom {
		if ef.ConfigMapRef != nil {
			refs = append(refs, objectRef{fmt.Sprintf("envFrom[%d].configMapRef", i), ef.ConfigMapRef.Name})
		}
	}
	for _, v := range spec.Volumes {
		if v.ConfigMap != nil {
			refs = append(refs, objectRef{fmt.Sprintf("volumes[%s].configMap", v.Name), v.ConfigMap.Name})
		}
		if v.Projected != nil {
			for i, s := range v.Projected.Sources {
				if s.ConfigMap != nil {
					refs = append(refs, objectRef{fmt.Sprintf("volumes[%s].projected.sources[%d].configMap", v.Name, i), s.ConfigMap.Name})
				}
			}
		}
	}
	return refs
}

// zoneDatabaseSecrets returns the Secret names a zone binds through
// spec.database (its db-bind Secrets).
func zoneDatabaseSecrets(app *appsv1alpha1.NextApp) []string {
	if app == nil || app.Spec.Database == nil {
		return nil
	}
	var names []string
	if app.Spec.Database.SecretRef != nil && app.Spec.Database.SecretRef.Name != "" {
		names = append(names, app.Spec.Database.SecretRef.Name)
	}
	if app.Spec.Database.ROSecretRef != nil && app.Spec.Database.ROSecretRef.Name != "" {
		names = append(names, app.Spec.Database.ROSecretRef.Name)
	}
	return names
}

// ownerReferencesNextApp reports whether an ownerReference points at a NextApp.
func ownerReferencesNextApp(ref metav1.OwnerReference) bool {
	return ref.Kind == "NextApp" && strings.HasPrefix(ref.APIVersion, appsv1alpha1.GroupVersion.Group+"/")
}

// checkFunctionSovereignty applies the allowlist to every Secret and ConfigMap
// reference in the function's spec and returns the refused ones, in spec order.
//
// For each Secret reference, the DENY rules are checked first and win:
//  1. any zone's signing-key Secret (the private key never reaches a function);
//  2. another zone's database Secret (even if relabelled for this zone);
//  3. a Secret marked for another zone (label or NextApp ownerReference).
//
// Then the ALLOW rules:
//  4. the owning zone's own database Secret;
//  5. a Secret marked for the owning zone (label, or an ownerReference to the
//     zone's NextApp with its UID).
//
// Anything else, including a Secret that does not exist, is refused. With no
// resolved zone (zone == nil) nothing is allowed.
//
// For ConfigMaps the only rule is that a function may not reference another
// zone's JWKS ConfigMap; the operator mounts the owning zone's itself.
func checkFunctionSovereignty(
	bs *appsv1alpha1.BackendService,
	zone *appsv1alpha1.NextApp,
	others []appsv1alpha1.NextApp,
	lookup secretLookup,
) ([]sovereigntyViolation, []unverifiedSecret) {
	out, unverified := checkSecretRefs(functionSecretRefs(&bs.Spec), bs, zone, others, lookup, false)

	zoneName := bs.Spec.Zone
	if zone != nil {
		zoneName = zone.Name
	}
	ownJWKS := ZoneJWKSConfigMapName(zoneName)
	for _, ref := range functionConfigMapRefs(&bs.Spec) {
		if strings.HasSuffix(ref.name, zoneJWKSConfigMapSuffix) && ref.name != ownJWKS {
			out = append(out, sovereigntyViolation{ref.source, ref.name,
				fmt.Sprintf("ConfigMap %q is another zone's JWKS; a function mounts only its own zone's (the operator does that)", ref.name)})
		}
	}
	return out, unverified
}

// checkRunningSovereignty applies the SAME Secret allowlist to the Secret
// references of the function's RUNNING Knative Service. When a pass cannot
// decide the spec's own Secrets, the running template is what stays up, so it is
// what must still be checked: otherwise a Secret revoked since it was rendered
// stays mounted for as long as the owner can make a read fail.
//
// Only POSITIVE evidence of revocation counts here: the Secret was re-marked
// for another zone (or no longer carries this zone's mark), it is another zone's
// database Secret or a signing key, or the zone is gone. A Secret the old
// template mounts that is simply NOT FOUND is a routine rotation (the new
// version was created, the spec points at it, the old one was pruned) and is
// never a violation: the new template replaces the old one.
func checkRunningSovereignty(
	bs *appsv1alpha1.BackendService,
	zone *appsv1alpha1.NextApp,
	others []appsv1alpha1.NextApp,
	lookup secretLookup,
	running *servingv1.Service,
) ([]sovereigntyViolation, []unverifiedSecret) {
	if running == nil {
		return nil, nil
	}
	return checkSecretRefs(runningSecretRefs(running), bs, zone, others, lookup, true)
}

// checkSecretRefs is the Secret half of the allowlist, over any list of refs.
// absentIsRotation is set for the RUNNING template: a Secret that is not found
// there is a pruned old version, not a violation.
func checkSecretRefs(
	refs []objectRef,
	bs *appsv1alpha1.BackendService,
	zone *appsv1alpha1.NextApp,
	others []appsv1alpha1.NextApp,
	lookup secretLookup,
	absentIsRotation bool,
) ([]sovereigntyViolation, []unverifiedSecret) {
	foreignDB := map[string]string{} // secret name -> owning zone
	for i := range others {
		for _, name := range zoneDatabaseSecrets(&others[i]) {
			foreignDB[name] = others[i].Name
		}
	}
	ownDB := map[string]bool{}
	for _, name := range zoneDatabaseSecrets(zone) {
		ownDB[name] = true
	}
	zoneName := bs.Spec.Zone
	if zone != nil {
		zoneName = zone.Name
	}

	var out []sovereigntyViolation
	var unverified []unverifiedSecret
	unverifiedSeen := map[string]bool{}
	meta := map[string]secretMetadata{}
	for _, ref := range refs {
		if problem := secretNameProblem(ref.name); problem != "" {
			// A name no Secret can have is a definitive answer about the
			// reference, not a read that "failed": never "unknown".
			out = append(out, sovereigntyViolation{ref.source, ref.name,
				fmt.Sprintf("%q is not a valid Secret name (%s)", ref.name, problem)})
			continue
		}
		if strings.HasSuffix(ref.name, zoneSigningKeySecretSuffix) {
			out = append(out, sovereigntyViolation{ref.source, ref.name,
				fmt.Sprintf("Secret %q is a zone signing key; a function never mounts a zone's private key", ref.name)})
			continue
		}
		if owner, ok := foreignDB[ref.name]; ok {
			out = append(out, sovereigntyViolation{ref.source, ref.name,
				fmt.Sprintf("Secret %q is zone %q's database Secret; a function may hold only its own zone's database credential", ref.name, owner)})
			continue
		}
		m, seen := meta[ref.name]
		if !seen {
			m = lookup(ref.name)
			meta[ref.name] = m
		}
		if other := foreignMark(m, zoneName, zone); other != "" {
			out = append(out, sovereigntyViolation{ref.source, ref.name,
				fmt.Sprintf("Secret %q is marked for zone %q, not zone %q", ref.name, other, zoneName)})
			continue
		}
		if zone == nil {
			out = append(out, sovereigntyViolation{ref.source, ref.name,
				fmt.Sprintf("Secret %q cannot be checked: zone %q does not exist, so no Secret is allowed", ref.name, zoneName)})
			continue
		}
		if ownDB[ref.name] || markedFor(m, zone) {
			continue
		}
		if m.readErr != "" {
			// Could not decide: not a violation (#2498).
			if !unverifiedSeen[ref.name] {
				unverifiedSeen[ref.name] = true
				unverified = append(unverified, unverifiedSecret{ref.source, ref.name, m.readErr, m.denied})
			}
			continue
		}
		if absentIsRotation && !m.found {
			continue
		}
		out = append(out, sovereigntyViolation{ref.source, ref.name,
			fmt.Sprintf("Secret %q is not zone %q's database Secret and is not marked for zone %q "+
				"(label it %s=%s, or give it an ownerReference to the zone)", ref.name, zoneName, zoneName, ZoneLabel, zoneName)})
	}
	return out, unverified
}

// secretNameProblem returns why a Secret reference's name can never name a
// Secret ("" when it can). A Secret name is a DNS-1123 subdomain, so an empty
// name, "..", "a/b" or an upper-case name never exists, and the metadata client
// refuses to send some of them at all.
func secretNameProblem(name string) string {
	if name == "" {
		return "empty"
	}
	if msgs := validation.IsDNS1123Subdomain(name); len(msgs) > 0 {
		return msgs[0]
	}
	return ""
}

// runningSecretRefs lists every Secret the running Knative Service's pod
// template references, in template order.
func runningSecretRefs(ksvc *servingv1.Service) []objectRef {
	var refs []objectRef
	ps := ksvc.Spec.Template.Spec.PodSpec
	containers := append(append([]corev1.Container{}, ps.InitContainers...), ps.Containers...)
	for _, c := range containers {
		for _, e := range c.Env {
			if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
				refs = append(refs, objectRef{fmt.Sprintf("the running Knative Service: container %s env[%s].valueFrom.secretKeyRef", c.Name, e.Name), e.ValueFrom.SecretKeyRef.Name})
			}
		}
		for i, ef := range c.EnvFrom {
			if ef.SecretRef != nil {
				refs = append(refs, objectRef{fmt.Sprintf("the running Knative Service: container %s envFrom[%d].secretRef", c.Name, i), ef.SecretRef.Name})
			}
		}
	}
	for _, v := range ps.Volumes {
		if v.Secret != nil {
			refs = append(refs, objectRef{fmt.Sprintf("the running Knative Service: volumes[%s].secret", v.Name), v.Secret.SecretName})
		}
		if v.Projected != nil {
			for i, s := range v.Projected.Sources {
				if s.Secret != nil {
					refs = append(refs, objectRef{fmt.Sprintf("the running Knative Service: volumes[%s].projected.sources[%d].secret", v.Name, i), s.Secret.Name})
				}
			}
		}
	}
	return refs
}

// foreignMark returns the other zone a Secret is marked for, or "".
func foreignMark(m secretMetadata, zoneName string, zone *appsv1alpha1.NextApp) string {
	if v, ok := m.labels[ZoneLabel]; ok && v != zoneName {
		return v
	}
	for _, ref := range m.ownerRefs {
		if !ownerReferencesNextApp(ref) {
			continue
		}
		if ref.Name != zoneName {
			return ref.Name
		}
	}
	return ""
}

// markedFor reports whether a Secret carries this zone's mark: the label, or a
// NextApp ownerReference naming the zone by name AND UID.
func markedFor(m secretMetadata, zone *appsv1alpha1.NextApp) bool {
	if !m.found {
		return false
	}
	if m.labels[ZoneLabel] == zone.Name {
		return true
	}
	for _, ref := range m.ownerRefs {
		if ownerReferencesNextApp(ref) && ref.Name == zone.Name && ref.UID == zone.UID {
			return true
		}
	}
	return false
}

// databaseHostFinding is one env literal the LINT flags.
type databaseHostFinding struct {
	env  string
	host string
	// zone is the other zone whose cluster the host names (by name prefix), or
	// "" when the finding is about another namespace.
	zone string
	// otherNamespace is set when the host names a namespace other than the
	// function's.
	otherNamespace string
}

func (f databaseHostFinding) String() string {
	if f.otherNamespace != "" {
		return fmt.Sprintf("env %s names database host %q in namespace %q", f.env, f.host, f.otherNamespace)
	}
	return fmt.Sprintf("env %s names zone %q's database host %q", f.env, f.zone, f.host)
}

// cnpgServiceSuffixes are the CloudNativePG service suffixes the lint looks
// for: the read-write primary and the read-only replicas.
var cnpgServiceSuffixes = []string{"-rw", "-ro"}

// lintForeignDatabaseHosts is the database-host LINT (a heuristic, NOT the
// sovereignty control). It scans the function's env LITERALS for a
// CloudNativePG-shaped service (<cluster>-rw / <cluster>-ro) and flags it when
//   - the host names another namespace (<cluster>-rw.<other-ns>...), or
//   - the cluster name equals, or is prefixed by "<zone>-", ANOTHER NextApp's
//     name in the namespace, and that zone is the longest such match (so a
//     zone "orders-archive" owns "orders-archive-db" even beside a zone
//     "orders").
//
// It reads only env[].value: a Secret's content, an IP address, an
// ExternalName Service and a URL built at run time all get past it, which is
// why it only warns.
func lintForeignDatabaseHosts(
	bs *appsv1alpha1.BackendService,
	zone *appsv1alpha1.NextApp,
	others []appsv1alpha1.NextApp,
) []databaseHostFinding {
	zoneName := bs.Spec.Zone
	if zone != nil {
		zoneName = zone.Name
	}
	zones := []string{zoneName}
	for i := range others {
		zones = append(zones, others[i].Name)
	}
	// Longest name first, so the first match is the longest prefix.
	sort.SliceStable(zones, func(i, j int) bool { return len(zones[i]) > len(zones[j]) })

	var out []databaseHostFinding
	for _, e := range bs.Spec.Env {
		if e.Value == "" {
			continue
		}
		for _, token := range hostTokens(e.Value) {
			labels := strings.Split(token, ".")
			cluster, ok := cnpgCluster(labels[0])
			if !ok {
				continue
			}
			if len(labels) > 1 && labels[1] != "svc" && labels[1] != bs.Namespace {
				out = append(out, databaseHostFinding{env: e.Name, host: token, otherNamespace: labels[1]})
				continue
			}
			for _, z := range zones {
				if cluster == z || strings.HasPrefix(cluster, z+"-") {
					if z != zoneName {
						out = append(out, databaseHostFinding{env: e.Name, host: token, zone: z})
					}
					break
				}
			}
		}
	}
	return out
}

// cnpgCluster strips a CNPG service suffix from a DNS label.
func cnpgCluster(label string) (string, bool) {
	for _, suffix := range cnpgServiceSuffixes {
		if strings.HasSuffix(label, suffix) && len(label) > len(suffix) {
			return strings.TrimSuffix(label, suffix), true
		}
	}
	return "", false
}

// hostTokens splits a value into lower-cased runs of DNS characters, which is
// where a host (bare, or inside a URL or DSN) appears.
func hostTokens(value string) []string {
	return strings.FieldsFunc(strings.ToLower(value), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '.')
	})
}
