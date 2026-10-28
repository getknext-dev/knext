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

package writepolicy

import (
	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
)

// celPair is the part of a policy variable or validation that decides what is
// admitted: its CEL. A variable is identified by Name; a validation is
// identified by its position. Cosmetic fields (message, reason) are not part of
// the comparison; messageExpression is, because it is CEL the apiserver
// evaluates on every refusal.
type celPair struct {
	Name              string
	Expression        string
	MessageExpression string
}

// The CEL config/admission/secret-configmap-writes.yaml ships, copied here
// verbatim. A policy whose matchConstraints, identity and binding are all right
// still enforces nothing if its validations were replaced by `true`, so the
// check compares them with this copy.
//
// KEEP IN LOCKSTEP with the shipped policy:
// TestCanonicalPolicyCELEqualsTheShippedPolicy fails if config/admission changes
// without this, and packages/kn-next/src/cli/doctor/checks/write-policy.ts holds
// the same copy (checked by its own test).
//
// A consequence worth stating: an operator that ships newer CEL than the policy
// installed in the cluster (an upgraded operator over a not-yet-reapplied
// bundle) reports PolicyModified until the bundle is reapplied. That is the
// honest answer; the installed policy is not the one this operator expects.
var canonicalVariables = []celPair{
	{Name: "objectName", Expression: "request.operation == 'DELETE' ? oldObject.metadata.name : object.metadata.name"},
	{Name: "allowedSecretSuffixes", Expression: "['-knext-signing-key']"},
	{Name: "allowedConfigMapSuffixes", Expression: "['-knext-jwks']"},
	{Name: "allowedSecretType", Expression: "'Opaque'"},
	{Name: "allowedSuffixes", Expression: "request.resource.resource == 'secrets' ? variables.allowedSecretSuffixes : variables.allowedConfigMapSuffixes"},
	{Name: "newOwners", Expression: "request.operation == 'DELETE' || !has(object.metadata.ownerReferences) ? [] : object.metadata.ownerReferences"},
	{Name: "oldOwners", Expression: "request.operation == 'CREATE' || !has(oldObject.metadata.ownerReferences) ? [] : oldObject.metadata.ownerReferences"},
	{Name: "zoneOwners", Expression: "request.operation == 'CREATE' ? variables.newOwners : variables.oldOwners"},
}

var canonicalValidations = []celPair{
	{
		Expression:        "variables.allowedSuffixes.exists(s, variables.objectName.endsWith(s) && size(variables.objectName) > size(s))",
		MessageExpression: "'the knext operator may not ' + request.operation.lowerAscii() + ' the ' + request.resource.resource + ' object \"' + variables.objectName + '\": it writes only the per-zone signing key and JWKS'",
	},
	{
		Expression: "request.resource.resource != 'secrets' || request.operation == 'DELETE' || dyn(object).type == variables.allowedSecretType",
	},
	{
		Expression: "variables.allowedSuffixes.exists(s, variables.zoneOwners.exists(r, has(r.controller) && r.controller == true && r.kind == 'NextApp' && r.apiVersion.startsWith('apps.kn-next.dev/') && r.name + s == variables.objectName))",
	},
	{
		Expression: "request.operation != 'UPDATE' || variables.newOwners == variables.oldOwners",
	},
}

// policyCELSet is a policy's variables and validations, reduced to their CEL.
type policyCELSet struct {
	Variables   []celPair
	Validations []celPair
}

func canonicalCEL() policyCELSet {
	return policyCELSet{Variables: canonicalVariables, Validations: canonicalValidations}
}

func policyCEL(p *admissionregistrationv1.ValidatingAdmissionPolicy) policyCELSet {
	var out policyCELSet
	for _, v := range p.Spec.Variables {
		out.Variables = append(out.Variables, celPair{Name: v.Name, Expression: v.Expression})
	}
	for _, v := range p.Spec.Validations {
		out.Validations = append(out.Validations, celPair{Expression: v.Expression, MessageExpression: v.MessageExpression})
	}
	return out
}
