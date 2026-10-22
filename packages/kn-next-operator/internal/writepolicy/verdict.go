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

// Package writepolicy answers one question the operator's bundle cannot answer
// for itself: is the ValidatingAdmissionPolicy that confines this operator's
// Secret and ConfigMap writes actually in force?
//
// The policy (config/admission) is the only thing that bounds the operator's
// cluster-wide create/update on Secrets and ConfigMaps, because RBAC cannot
// restrict `create` by name. It can be off with nothing reporting it: a server
// older than 1.30 rejects the two objects while the rest of the bundle applies;
// an install under another namespace or service-account name leaves a
// matchCondition that matches nobody; a cluster admin or a GitOps prune deletes
// the objects. In each case the operator is simply unrestricted.
//
// Evaluate is the pure verdict; Monitor reads the live objects with a plain
// `get`, publishes the verdict as the knext_operator_write_policy_enforced
// gauge, and warns once per change. It never refuses to start and never writes.
//
// KEEP IN LOCKSTEP with `knext doctor`: the same verdict is computed in
// packages/kn-next/src/cli/doctor/checks/write-policy.ts, and both are held to
// testdata/verdict-cases.json.
package writepolicy

import (
	"fmt"
	"reflect"
	"regexp"
	"strings"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Reason names why the policy is, or is not, in force. The values are stable
// strings: the doctor check and the shared test table use the same spellings.
type Reason string

const (
	// ReasonEnforced: the policy and its binding exist, the binding denies, and
	// the policy names the identity the operator runs as.
	ReasonEnforced Reason = "Enforced"
	// ReasonPolicyMissing: no ValidatingAdmissionPolicy of the expected name
	// (deleted, pruned, or never created because the server is older than 1.30).
	ReasonPolicyMissing Reason = "PolicyMissing"
	// ReasonBindingMissing: the policy exists but nothing binds it, so it is
	// never evaluated.
	ReasonBindingMissing Reason = "BindingMissing"
	// ReasonIdentityUnknown: the operator could not establish its own username.
	ReasonIdentityUnknown Reason = "IdentityUnknown"
	// ReasonPolicyFailsOpen: failurePolicy Ignore turns an evaluation error into
	// an unrestricted write.
	ReasonPolicyFailsOpen Reason = "PolicyFailsOpen"
	// ReasonPolicyScope: the policy does not cover create, update and delete on
	// both Secrets and ConfigMaps, or narrows by namespace or object selector.
	ReasonPolicyScope Reason = "PolicyScope"
	// ReasonPolicyModified: the policy's variables or validations are not the CEL
	// this operator ships, so what it admits is not what the bundle intended
	// (for example a validation replaced by `true`).
	ReasonPolicyModified Reason = "PolicyModified"
	// ReasonIdentityUnparseable: the matchCondition is not a plain equality on
	// request.userInfo.username, so which principal it confines cannot be read.
	ReasonIdentityUnparseable Reason = "IdentityUnparseable"
	// ReasonIdentityMismatch: the matchCondition names a different principal
	// than the operator runs as, so it matches nobody the operator is.
	ReasonIdentityMismatch Reason = "IdentityMismatch"
	// ReasonBindingPolicyMismatch: the binding names another policy.
	ReasonBindingPolicyMismatch Reason = "BindingPolicyMismatch"
	// ReasonBindingNotDeny: the binding only warns or audits, which refuses
	// nothing.
	ReasonBindingNotDeny Reason = "BindingNotDeny"
	// ReasonBindingScoped: the binding limits the policy to some namespaces or
	// objects, but the operator writes in all of them.
	ReasonBindingScoped Reason = "BindingScoped"
	// ReasonUnverifiable: the objects or the operator's identity could not be
	// read (RBAC, transport). Unknown is reported as not enforced, never as
	// enforced.
	ReasonUnverifiable Reason = "Unverifiable"
)

// Verdict is the outcome of one check.
type Verdict struct {
	Enforced bool
	Reason   Reason
	// Detail is one sentence for a human; empty only when Enforced.
	Detail string
}

func no(reason Reason, format string, args ...any) Verdict {
	return Verdict{Reason: reason, Detail: fmt.Sprintf(format, args...)}
}

// identityExpr is the one matchCondition shape the shipped policy uses and the
// only one the check will read: an equality on the username against string
// literals joined with +. Anything richer (startsWith, !=, ||) is not an
// exact-identity confinement and is reported rather than guessed at.
var identityExpr = regexp.MustCompile(`^\s*request\.userInfo\.username\s*==\s*('[^']*'(?:\s*\+\s*'[^']*')*)\s*$`)

var celLiteral = regexp.MustCompile(`'([^']*)'`)

// confinedUsername returns the username the policy's matchCondition confines.
func confinedUsername(p *admissionregistrationv1.ValidatingAdmissionPolicy) (string, bool) {
	if len(p.Spec.MatchConditions) != 1 {
		return "", false
	}
	m := identityExpr.FindStringSubmatch(p.Spec.MatchConditions[0].Expression)
	if m == nil {
		return "", false
	}
	var b strings.Builder
	for _, l := range celLiteral.FindAllStringSubmatch(m[1], -1) {
		b.WriteString(l[1])
	}
	return b.String(), true
}

// selectorNarrows reports whether a label selector selects less than
// everything. The apiserver defaults an absent selector to the empty one, which
// selects everything, so the empty selector is not a narrowing.
func selectorNarrows(s *metav1.LabelSelector) bool {
	return s != nil && (len(s.MatchLabels) > 0 || len(s.MatchExpressions) > 0)
}

// scopeCoversNamespaced: Secrets and ConfigMaps are namespaced, so a rule scoped
// "Cluster" never matches them. An absent scope means all.
func scopeCoversNamespaced(s *admissionregistrationv1.ScopeType) bool {
	return s == nil || *s == admissionregistrationv1.NamespacedScope || *s == admissionregistrationv1.AllScopes
}

func has(list []string, want string) bool {
	for _, v := range list {
		if v == want || v == "*" {
			return true
		}
	}
	return false
}

// covers reports whether the policy's rules reach every (resource, operation)
// the operator's writes need confining on: Secrets and ConfigMaps in the core
// group, on create, update and delete.
func covers(p *admissionregistrationv1.ValidatingAdmissionPolicy) (missing string) {
	mc := p.Spec.MatchConstraints
	if mc == nil {
		return "it has no matchConstraints"
	}
	// Any exclusion could be carving Secrets or ConfigMaps (or an operation) back
	// out of the rules below, and reading which is a re-implementation of the
	// apiserver's matching. The shipped policy has none, so none is accepted.
	if len(mc.ExcludeResourceRules) > 0 {
		return "it excludes some requests through excludeResourceRules"
	}
	for _, resource := range []string{"secrets", "configmaps"} {
		for _, op := range []admissionregistrationv1.OperationType{
			admissionregistrationv1.Create, admissionregistrationv1.Update, admissionregistrationv1.Delete,
		} {
			found := false
			for _, r := range mc.ResourceRules {
				ops := make([]string, 0, len(r.Operations))
				for _, o := range r.Operations {
					ops = append(ops, string(o))
				}
				// A rule that names objects, is cluster-scoped, or is for another
				// apiVersion does not cover the operator's writes, however it spells
				// the resources.
				if has(r.APIGroups, "") && has(r.APIVersions, "v1") && has(r.Resources, resource) && has(ops, string(op)) &&
					len(r.ResourceNames) == 0 && scopeCoversNamespaced(r.Scope) {
					found = true
				}
			}
			if !found {
				return fmt.Sprintf("it does not cover %s on %s", op, resource)
			}
		}
	}
	return ""
}

// Evaluate decides whether the write policy is in force for the operator that
// runs as operatorUsername. policy and binding are nil when the object does not
// exist. The checks run in a fixed order, so the first thing wrong is the
// reason reported.
func Evaluate(policy *admissionregistrationv1.ValidatingAdmissionPolicy, binding *admissionregistrationv1.ValidatingAdmissionPolicyBinding, operatorUsername string) Verdict {
	if policy == nil {
		return no(ReasonPolicyMissing, "the ValidatingAdmissionPolicy that limits the operator's Secret and ConfigMap writes does not exist "+
			"(deleted or pruned, or the server is older than Kubernetes 1.30, which rejects it): the operator is unrestricted")
	}
	if binding == nil {
		return no(ReasonBindingMissing, "the policy %q exists but no ValidatingAdmissionPolicyBinding of that name does, so it is never evaluated: "+
			"the operator is unrestricted", policy.Name)
	}
	if operatorUsername == "" {
		return no(ReasonIdentityUnknown, "the operator could not establish the username it runs as, so the policy's identity cannot be compared with it")
	}
	if fp := policy.Spec.FailurePolicy; fp != nil && *fp == admissionregistrationv1.Ignore {
		return no(ReasonPolicyFailsOpen, "the policy %q has failurePolicy Ignore, so an evaluation error lets the write through", policy.Name)
	}
	if why := covers(policy); why != "" {
		return no(ReasonPolicyScope, "the policy %q does not confine every write the operator makes: %s", policy.Name, why)
	}
	if mc := policy.Spec.MatchConstraints; selectorNarrows(mc.NamespaceSelector) || selectorNarrows(mc.ObjectSelector) {
		return no(ReasonPolicyScope, "the policy %q narrows by namespace or object selector, but the operator writes in every namespace", policy.Name)
	}
	confined, ok := confinedUsername(policy)
	if !ok {
		return no(ReasonIdentityUnparseable, "the policy %q does not confine one exact username (its matchCondition is not an equality on "+
			"request.userInfo.username), so which principal it limits cannot be verified", policy.Name)
	}
	if confined != operatorUsername {
		return no(ReasonIdentityMismatch, "the policy %q confines %q but the operator runs as %q: it matches nobody the operator is "+
			"(installed under another namespace or service-account name than the bundle rendered?)", policy.Name, confined, operatorUsername)
	}
	if !reflect.DeepEqual(policyCEL(policy), canonicalCEL()) {
		return no(ReasonPolicyModified, "the policy %q does not carry the variables and validations this operator ships, so what it admits is not what "+
			"the bundle intended (its validation CEL, an allow-list variable or a messageExpression was changed, added or removed)", policy.Name)
	}
	if binding.Spec.PolicyName != policy.Name {
		return no(ReasonBindingPolicyMismatch, "the binding %q names policy %q, not %q", binding.Name, binding.Spec.PolicyName, policy.Name)
	}
	deny := false
	for _, a := range binding.Spec.ValidationActions {
		deny = deny || a == admissionregistrationv1.Deny
	}
	if !deny {
		return no(ReasonBindingNotDeny, "the binding %q does not include the Deny action (actions %v): a violation is warned about or audited, never refused",
			binding.Name, binding.Spec.ValidationActions)
	}
	if mr := binding.Spec.MatchResources; mr != nil &&
		(selectorNarrows(mr.NamespaceSelector) || selectorNarrows(mr.ObjectSelector) ||
			len(mr.ResourceRules) > 0 || len(mr.ExcludeResourceRules) > 0) {
		return no(ReasonBindingScoped, "the binding %q limits the policy to some namespaces or objects, but the operator writes in every namespace", binding.Name)
	}
	return Verdict{Enforced: true, Reason: ReasonEnforced}
}
