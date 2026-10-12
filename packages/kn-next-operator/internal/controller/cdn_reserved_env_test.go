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

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The KNEXT_CDN_* reservation is enforced by the OPERATOR (ignore at render +
// the CDNReservedEnvIgnored condition), not by CRD CEL: a new CEL rule on the
// existing spec.env / spec.secrets.envMap fields would break the additive-only
// rule inside v1alpha1 (ADR-0017 Amendment 2). The condition is computed in
// computeStatusVerdict from the spec alone, names the offending entries, and
// never carries a value.

func reservedApp(env map[string]string, envMap map[string]appsv1alpha1.EnvMapEntry) *appsv1alpha1.NextApp {
	app := verdictApp()
	app.Spec.Env = env
	if envMap != nil {
		app.Spec.Secrets = &appsv1alpha1.SecretsSpec{EnvMap: envMap}
	}
	return app
}

func TestCDNReservedEnvIgnored_ReportsNamesNotValues(t *testing.T) {
	app := reservedApp(
		map[string]string{"KNEXT_CDN_B": "value-b-secret", "KNEXT_CDN_A": "value-a-secret", "KEEP": "1"},
		map[string]appsv1alpha1.EnvMapEntry{
			"KNEXT_CDN_C": {SecretName: "secret-name-xyz", SecretKey: "key-xyz"},
			"OTHER":       {SecretName: "s", SecretKey: "k"},
		},
	)
	v := cdnVerdict(app)
	c, ok := cdnCondition(v, ConditionCDNReservedEnvIgnored)
	if !ok {
		t.Fatalf("expected %s, got %v", ConditionCDNReservedEnvIgnored, conditionTypes(v))
	}
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonCDNReservedEnvIgnored {
		t.Errorf("got %+v", c)
	}
	a := strings.Index(c.Message, "spec.env[KNEXT_CDN_A]")
	b := strings.Index(c.Message, "spec.env[KNEXT_CDN_B]")
	cc := strings.Index(c.Message, "spec.secrets.envMap[KNEXT_CDN_C]")
	if a < 0 || b <= a || cc <= b {
		t.Errorf("names must be listed sorted, spec.env first then envMap: %q", c.Message)
	}
	for _, leak := range []string{"value-a-secret", "value-b-secret", "secret-name-xyz", "key-xyz", "KEEP", "OTHER"} {
		if strings.Contains(c.Message, leak) {
			t.Errorf("the message must carry names of reserved entries only, found %q in %q", leak, c.Message)
		}
	}
	if len(v.events) != 1 || v.events[0].reason != ReasonCDNReservedEnvIgnored {
		t.Errorf("want one transition Warning event, got %+v", v.events)
	}
}

func TestCDNReservedEnvIgnored_AbsentWhenNothingIsReserved(t *testing.T) {
	cases := map[string]*appsv1alpha1.NextApp{
		"nothing set":    reservedApp(nil, nil),
		"lookalikes":     reservedApp(map[string]string{"KNEXT_CDNX": "1", "MY_KNEXT_CDN_X": "1", "knext_cdn_lower": "1"}, nil),
		"plain env only": reservedApp(map[string]string{"A": "1"}, map[string]appsv1alpha1.EnvMapEntry{"B": {SecretName: "s", SecretKey: "k"}}),
	}
	for name, app := range cases {
		t.Run(name, func(t *testing.T) {
			v := cdnVerdict(app)
			if c, ok := cdnCondition(v, ConditionCDNReservedEnvIgnored); ok {
				t.Errorf("unexpected %+v", c)
			}
			for _, rc := range v.removeConditions {
				if rc == ConditionCDNReservedEnvIgnored {
					t.Errorf("a never-reported app must not grow a removal of %s (#98 no-op)", ConditionCDNReservedEnvIgnored)
				}
			}
		})
	}
}

func TestCDNReservedEnvIgnored_ClearsOnceTheEntriesAreGone(t *testing.T) {
	app := reservedApp(nil, nil)
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionCDNReservedEnvIgnored, Status: metav1.ConditionTrue, Reason: ReasonCDNReservedEnvIgnored, Message: "old",
	}}
	v := cdnVerdict(app)
	removed := false
	for _, rc := range v.removeConditions {
		if rc == ConditionCDNReservedEnvIgnored {
			removed = true
		}
	}
	if !removed {
		t.Errorf("a stale condition must be removed, removeConditions = %v", v.removeConditions)
	}
}

func TestCDNReservedEnvIgnored_EventIsTransitionGated(t *testing.T) {
	app := reservedApp(map[string]string{"KNEXT_CDN_A": "1"}, nil)
	first := cdnVerdict(app)
	c, _ := cdnCondition(first, ConditionCDNReservedEnvIgnored)
	// Converged pass: the same condition is already in status -> no new event.
	app.Status.Conditions = []metav1.Condition{c}
	if second := cdnVerdict(app); len(second.events) != 0 {
		t.Errorf("a converged pass must be quiet, got %+v", second.events)
	}
	// The set changes -> a new event.
	app.Spec.Env["KNEXT_CDN_B"] = "2"
	if third := cdnVerdict(app); len(third.events) != 1 {
		t.Errorf("a changed set must fire once, got %+v", third.events)
	}
}

func TestCDNReservedEnvIgnored_DoesNotDependOnSpecCDNOrBuild(t *testing.T) {
	for name, mutate := range map[string]func(*appsv1alpha1.NextApp){
		"no spec.cdn": func(a *appsv1alpha1.NextApp) {},
		"spec.cdn":    func(a *appsv1alpha1.NextApp) { a.Spec.CDN = &appsv1alpha1.CDNSpec{Provider: "cloudflare"} },
		"vinext": func(a *appsv1alpha1.NextApp) {
			a.Spec.Build = "vinext"
			a.Spec.CDN = &appsv1alpha1.CDNSpec{Provider: "cloudflare"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			app := reservedApp(map[string]string{"KNEXT_CDN_PROVIDER": "x"}, nil)
			mutate(app)
			if _, ok := cdnCondition(cdnVerdict(app), ConditionCDNReservedEnvIgnored); !ok {
				t.Errorf("the reservation holds in every configuration")
			}
		})
	}
}
