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
	"context"
	"fmt"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// spec.cache.keyPrefix admission (#2398). envtest loads the REAL generated CRD
// (suite_test.go's CRDDirectoryPaths), so these Creates go through the same
// pattern / maxLength / CEL validation a real apiserver applies, before the
// operator ever sees the object.
//
// The rules, kept in lockstep with the runtime's escapeGlob (the Redis glob
// metacharacters * ? [ ] \) and with the CLI (packages/kn-next/src/cli/
// redis-key-prefix.ts, which reads this CRD in its lockstep test):
//   - no Redis glob metacharacter and no ASCII whitespace;
//   - at most 63 characters;
//   - not the shared fallback "kn-next" and not under "kn-next:".
//
// The empty string stays VALID: an empty keyPrefix is unset, and the operator
// renders the derived kn-<12 hex> default in its place.
var _ = Describe("NextApp spec.cache.keyPrefix admission (#2398)", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)
	ctx := context.Background()

	appWithPrefix := func(name, prefix string) *appsv1alpha1.NextApp {
		return &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: validImage,
				Cache: &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://redis:6379", KeyPrefix: prefix},
			},
		}
	}

	rejected := []struct {
		name, prefix, why string
	}{
		{"star", "kn-*", "glob metacharacter *"},
		{"question", "kn-nex?", "glob metacharacter ?"},
		{"open-bracket", "kn-[a", "glob metacharacter ["},
		{"close-bracket", "kn-a]", "glob metacharacter ]"},
		{"backslash", `kn-a\b`, `glob escape character \`},
		{"space", "my app", "whitespace (space)"},
		{"tab", "my\tapp", "whitespace (tab)"},
		{"newline", "my\napp", "whitespace (newline)"},
		{"vtab", "my\vapp", "whitespace (vertical tab)"},
		{"too-long", strings.Repeat("a", 64), "longer than 63 characters"},
		{"reserved", "kn-next", "the shared fallback keyspace"},
		{"reserved-nested", "kn-next:cache", "nested under the shared fallback keyspace"},
	}
	for i, tc := range rejected {
		It(fmt.Sprintf("REJECTS keyPrefix %q — %s", tc.prefix, tc.why), func() {
			err := k8sClient.Create(ctx, appWithPrefix(fmt.Sprintf("keyprefix-bad-%d-%s", i, tc.name), tc.prefix))
			Expect(err).To(HaveOccurred(), "the apiserver admitted an invalid keyPrefix")
			Expect(errors.IsInvalid(err)).To(BeTrue(), "expected an Invalid (422) admission error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("spec.cache.keyPrefix"))
		})
	}

	admitted := []struct {
		name, prefix string
	}{
		{"plain", "myapp"},
		{"derived-shape", "kn-0123456789ab"},
		{"colon-namespaced", "tenant-a:shop"},
		{"near-reserved", "kn-nextapp"},
		{"near-reserved-dash", "kn-next-v2"},
		{"max-length", strings.Repeat("a", 63)},
		{"punctuation", "app.v1_blue@eu/1"},
		{"empty-is-unset", ""},
	}
	for i, tc := range admitted {
		It(fmt.Sprintf("ADMITS keyPrefix %q", tc.prefix), func() {
			name := fmt.Sprintf("keyprefix-ok-%d-%s", i, tc.name)
			Expect(k8sClient.Create(ctx, appWithPrefix(name, tc.prefix))).To(Succeed())
			nn := types.NamespacedName{Name: name, Namespace: namespace}
			DeferCleanup(func() {
				cur := &appsv1alpha1.NextApp{}
				if err := k8sClient.Get(ctx, nn, cur); err == nil {
					Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				}
			})
			stored := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, stored)).To(Succeed())
			Expect(stored.Spec.Cache.KeyPrefix).To(Equal(tc.prefix))
		})
	}
})
