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
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	rbacv1 "k8s.io/api/rbac/v1"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/yaml"
)

// Secrets RBAC least-privilege guard.
//
// The operator's Go code never reads or writes a core Secret: the managed
// database mode that once mirrored a DSN Secret was removed, envFrom /
// secretKeyRef are references the KUBELET resolves, image-pull secrets are only
// names on a ServiceAccount, and webhook / metrics certs arrive as mounted
// volumes. A Secrets grant on the manager's ClusterRole is therefore pure
// standing blast radius: a compromised operator could read every Secret in the
// cluster. This guard fails if ANY RBAC rule shipped under config/rbac (or any
// +kubebuilder:rbac marker that generates one) touches core Secrets, unless
// the grant is listed in secretsGrantAllowlist WITH a written justification.
//
// To legitimately add a grant: narrow it as far as the code allows
// (resourceNames, a namespaced Role, no list/watch), add the entry below, and
// document it in docs/security/threat-model.md — all in the same change.
//
// secretsGrantAllowlist is keyed "<Kind>/<name>:<sorted verbs>" for manifest
// rules and "marker:<sorted verbs>" for kubebuilder markers; the value is the
// justification. It is empty on purpose.
var secretsGrantAllowlist = map[string]string{}

type rbacRuleRef struct {
	file string
	kind string
	name string
	rule rbacv1.PolicyRule
}

// grantsCoreSecrets reports whether rule reaches core Secrets, including via
// wildcards (apiGroups "*" or resources "*") — a wildcard is the obvious way
// to sneak the grant back in past a string match on "secrets".
func grantsCoreSecrets(rule rbacv1.PolicyRule) bool {
	groupOK := false
	for _, g := range rule.APIGroups {
		if g == "" || g == "*" || g == "core" {
			groupOK = true
		}
	}
	if !groupOK {
		return false
	}
	for _, r := range rule.Resources {
		if r == "secrets" || r == "*" {
			return true
		}
	}
	return false
}

func sortedVerbs(rule rbacv1.PolicyRule) string {
	verbs := append([]string(nil), rule.Verbs...)
	sort.Strings(verbs)
	return strings.Join(verbs, ",")
}

func secretsGrantKey(r rbacRuleRef) string {
	return fmt.Sprintf("%s/%s:%s", r.kind, r.name, sortedVerbs(r.rule))
}

// loadRBACRules reads every Role / ClusterRole document in config/rbac.
func loadRBACRules(t *testing.T) []rbacRuleRef {
	t.Helper()
	dir := filepath.Join("..", "..", "config", "rbac")
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no RBAC manifests found under %s (err=%v)", dir, err)
	}
	var out []rbacRuleRef
	sawManagerRole := false
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		dec := utilyaml.NewYAMLReader(bufio.NewReader(bytes.NewReader(raw)))
		for {
			doc, err := dec.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatalf("split %s: %v", f, err)
			}
			var meta struct {
				Kind     string `json:"kind"`
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
				Rules []rbacv1.PolicyRule `json:"rules"`
			}
			if err := yaml.Unmarshal(doc, &meta); err != nil {
				t.Fatalf("unmarshal %s: %v", f, err)
			}
			if meta.Kind != "Role" && meta.Kind != "ClusterRole" {
				continue
			}
			if meta.Kind == "ClusterRole" && meta.Metadata.Name == "manager-role" {
				sawManagerRole = true
			}
			for _, rule := range meta.Rules {
				out = append(out, rbacRuleRef{file: filepath.Base(f), kind: meta.Kind, name: meta.Metadata.Name, rule: rule})
			}
		}
	}
	// Both-halves: a guard that parses nothing is decoration. The manager
	// ClusterRole MUST have been seen, or this scan proved nothing.
	if !sawManagerRole {
		t.Fatalf("ClusterRole manager-role not found under %s; the guard would pass vacuously", dir)
	}
	return out
}

func TestRBACSecretsLeastPrivilege(t *testing.T) {
	rules := loadRBACRules(t)

	used := map[string]bool{}
	for _, r := range rules {
		if !grantsCoreSecrets(r.rule) {
			continue
		}
		key := secretsGrantKey(r)
		why, ok := secretsGrantAllowlist[key]
		if !ok || strings.TrimSpace(why) == "" {
			t.Errorf("%s (%s) grants core Secrets [%s] with no justified entry in secretsGrantAllowlist (key %q). "+
				"The operator's code never touches Secrets; a cluster-wide Secrets grant lets a compromised operator read every Secret. "+
				"Narrow it (namespaced Role, resourceNames, no list/watch), add a justified allowlist entry, and update docs/security/threat-model.md.",
				r.kind+"/"+r.name, r.file, strings.Join(r.rule.Verbs, ","), key)
			continue
		}
		used[key] = true
		// Even a justified ClusterRole grant may not be cluster-wide list/watch
		// without resourceNames: that is the whole-cluster read primitive.
		if r.kind == "ClusterRole" && len(r.rule.ResourceNames) == 0 {
			for _, v := range r.rule.Verbs {
				if v == "list" || v == "watch" || v == "*" {
					t.Errorf("%s grants cluster-wide Secrets %q without resourceNames; an allowlist entry cannot waive this", r.kind+"/"+r.name, v)
				}
			}
		}
	}
	// A stale allowlist entry would silently pre-authorise a future re-add.
	for key := range secretsGrantAllowlist {
		if strings.HasPrefix(key, "marker:") {
			continue // checked by TestRBACMarkersDoNotGrantSecrets
		}
		if !used[key] {
			t.Errorf("secretsGrantAllowlist entry %q matches no RBAC rule; remove it (a stale waiver pre-authorises a future grant)", key)
		}
	}
}

// TestRBACMarkersDoNotGrantSecrets closes the other half: role.yaml is
// GENERATED from the +kubebuilder:rbac markers, so a re-added marker would
// regenerate the grant on the next `make manifests`. Scan every Go source
// (not an enumerated list) so a marker added in any file is seen.
func TestRBACMarkersDoNotGrantSecrets(t *testing.T) {
	root := filepath.Join("..", "..")
	seen := 0
	markers := 0
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			switch info.Name() {
			case "bin", "vendor", "node_modules", ".git":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		seen++
		for i, line := range strings.Split(string(raw), "\n") {
			l := strings.TrimSpace(line)
			if !strings.HasPrefix(l, "// +kubebuilder:rbac:") {
				continue
			}
			markers++
			rule, perr := parseRBACMarker(l)
			if perr != nil {
				t.Errorf("%s:%d: unparseable +kubebuilder:rbac marker (%v): %s", path, i+1, perr, l)
				continue
			}
			if grantsCoreSecrets(rule) {
				key := "marker:" + sortedVerbs(rule)
				if why, ok := secretsGrantAllowlist[key]; !ok || strings.TrimSpace(why) == "" {
					t.Errorf("%s:%d: +kubebuilder:rbac marker grants core Secrets [%s]; the operator never touches Secrets (see secretsGrantAllowlist, key %q)",
						path, i+1, strings.Join(rule.Verbs, ","), key)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if seen == 0 || markers == 0 {
		t.Fatalf("scanned %d Go files / %d rbac markers; the guard would pass vacuously", seen, markers)
	}
}

// parseRBACMarker parses `// +kubebuilder:rbac:groups=a;b,resources=x;y,verbs=get;list`.
func parseRBACMarker(line string) (rbacv1.PolicyRule, error) {
	var rule rbacv1.PolicyRule
	body := strings.TrimPrefix(line, "// +kubebuilder:rbac:")
	for _, part := range strings.Split(body, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			return rule, fmt.Errorf("bad key=value %q", part)
		}
		vals := strings.Split(strings.Trim(kv[1], `"`), ";")
		switch kv[0] {
		case "groups":
			rule.APIGroups = vals
		case "resources":
			rule.Resources = vals
		case "verbs":
			rule.Verbs = vals
		case "resourceNames":
			rule.ResourceNames = vals
		case "urls", "namespace":
			// not relevant to the Secrets scan
		default:
			return rule, fmt.Errorf("unknown key %q", kv[0])
		}
	}
	return rule, nil
}
