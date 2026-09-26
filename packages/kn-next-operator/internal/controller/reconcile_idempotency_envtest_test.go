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
	"encoding/json"
	"fmt"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// #1288 (issue comment, system-designer TD4 scope widening): #1285 was a
// revision-churn regression that a PURE unit test (envmap_order_test.go,
// buildKsvcEnv called 200x, DeepEqual) had already caught for envMap
// specifically — but nothing exercised this through a REAL Reconcile() with
// the full CreateOrUpdate/envtest path, and nothing covered the OTHER
// map-typed fields feeding the ksvc spec (spec.env, secrets.envFrom).
//
// envtest cannot assert an actual Knative Revision count: no Knative
// controller runs against envtest's API server to mint Revisions from a
// Configuration/Service diff (envtest is API server + etcd only). The
// equivalent, provable-here guarantee is what actually DRIVES revision
// cutting in real Knative: the rendered ksvc.Spec.Template must be
// BYTE-IDENTICAL across repeated reconciles of an unchanged NextApp — an
// unstable template (map iteration reordering the env list, e.g.) is
// exactly what produced 54 revisions in ~2 minutes on a real cluster (#1285).
var _ = Describe("NextApp reconcile idempotency — repeated reconciles never change the ksvc template", func() {
	const namespace = "default"
	const validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

	ctx := context.Background()

	It("renders a byte-identical ksvc.Spec.Template across 20 reconciles of an unchanged NextApp, covering every map-typed field (envMap, spec.env, secrets.envFrom)", func() {
		name := "idempotency-app"
		nn := types.NamespacedName{Name: name, Namespace: namespace}

		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: validImage,
				Secrets: &appsv1alpha1.SecretsSpec{
					// Multiple keys on every map-typed field: Go map iteration
					// order is randomized per-process, so a single-key map
					// would never have caught a reordering bug (#1285's own
					// root cause needed two envMap entries to surface).
					EnvFrom: []string{"secret-b", "secret-a", "secret-c"},
					EnvMap: map[string]appsv1alpha1.EnvMapEntry{
						"ZED_TOKEN":    {SecretName: "z", SecretKey: "z"},
						"API_TOKEN":    {SecretName: "a", SecretKey: "a"},
						"MID_TOKEN":    {SecretName: "m", SecretKey: "m"},
						"DATABASE_URL": {SecretName: "d", SecretKey: "d"},
					},
				},
				Env: map[string]string{
					"ZED_FLAG":    "1",
					"APP_FLAG":    "2",
					"MID_FLAG":    "3",
					"OTHER_FLAG":  "4",
					"ANOTHER_ONE": "5",
				},
			},
		}
		Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())

		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				cleanupReconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanupReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
					return errors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
				}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
			}
		})

		reconciler := &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: record.NewFakeRecorder(256),
		}

		const reconcileCount = 20
		templates := make([]string, 0, reconcileCount)
		for i := 0; i < reconcileCount; i++ {
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			// Marshal the WHOLE template (labels, annotations, containers —
			// every map-typed field the ksvc spec carries), not just the env
			// slice: the point is that Reconcile's real output is stable,
			// not that buildKsvcEnv alone is (that is already covered,
			// separately, by envmap_order_test.go's pure unit test).
			b, marshalErr := json.Marshal(ksvc.Spec.Template)
			Expect(marshalErr).NotTo(HaveOccurred())
			templates = append(templates, string(b))
		}

		first := templates[0]
		for i, tmpl := range templates {
			if tmpl != first {
				Fail(fmt.Sprintf(
					"ksvc.Spec.Template changed between reconciles of an UNCHANGED NextApp "+
						"(iteration %d) — this is exactly the #1285 revision-churn shape: a "+
						"map-typed field rendered in a different order, so Knative would cut a "+
						"new revision every reconcile.\nfirst: %s\n got: %s", i, first, tmpl))
			}
		}
	})
})
