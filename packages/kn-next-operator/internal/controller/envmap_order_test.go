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
	"reflect"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// spec.secrets.envMap is a Go map. Ranging it directly emits the Knative
// service's env list in a different order on every reconcile, so the revision
// template changes on every reconcile and Knative cuts a NEW revision each
// time (measured on kind: 54 revisions in ~2 minutes for an app with two
// envMap entries, ending Unschedulable and NextApp Ready=False). The env list
// must be a pure function of the CR.
func TestBuildKsvcEnv_EnvMapOrderIsDeterministic(t *testing.T) {
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "ns"},
		Spec: appsv1alpha1.NextAppSpec{
			Image: "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
			Secrets: &appsv1alpha1.SecretsSpec{
				EnvMap: map[string]appsv1alpha1.EnvMapEntry{
					"API_TOKEN":    {SecretName: "global-tokens", SecretKey: "t"},
					"DATABASE_URL": {SecretName: "db", SecretKey: "DATABASE_URL"},
					"REDIS_URL":    {SecretName: "r", SecretKey: "u"},
					"S3_KEY":       {SecretName: "s3", SecretKey: "k"},
					"ZED":          {SecretName: "z", SecretKey: "z"},
				},
			},
		},
	}
	r := &NextAppReconciler{}
	first, _ := r.buildKsvcEnv(app)
	for i := 0; i < 200; i++ {
		got, _ := r.buildKsvcEnv(app)
		if !reflect.DeepEqual(first, got) {
			t.Fatalf("env order changed between reconciles (iteration %d):\n first: %v\n  got: %v", i, names(first), names(got))
		}
	}
}

func names(vs []corev1.EnvVar) []string {
	out := make([]string, 0, len(vs))
	for _, v := range vs {
		out = append(out, v.Name)
	}
	return out
}
