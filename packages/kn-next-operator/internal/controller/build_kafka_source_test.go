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
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// buildKafkaSource is currently UNREACHABLE from Reconcile: `provisionKafkaSource`
// is inert (#475) because the `{app}-revalidator` sink it targets is not built, so
// revalidationDeferred is always true for `queue: kafka` and the caller's guard
// never opens. The construction is retained for the day that consumer ships
// (the open ADR-0016 action item) — and retained code that is also untested rots
// silently, so its shape is pinned here as a pure unit test. That keeps the
// coverage the reconcile-output shape assertions used to provide, without an
// envtest that would have to assert an object the operator must never create.
func TestBuildKafkaSourceShape(t *testing.T) {
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "shop", Namespace: "prod"},
		Spec: appsv1alpha1.NextAppSpec{
			Revalidation: &appsv1alpha1.RevalidationSpec{
				Queue:          "kafka",
				KafkaBrokerUrl: "kafka-broker:9092",
			},
		},
	}

	ks := buildKafkaSource(app)

	if got, want := ks.GetAPIVersion(), "sources.knative.dev/v1beta1"; got != want {
		t.Errorf("apiVersion = %q, want %q", got, want)
	}
	if got, want := ks.GetKind(), "KafkaSource"; got != want {
		t.Errorf("kind = %q, want %q", got, want)
	}
	if got, want := ks.GetName(), "shop-revalidation-source"; got != want {
		t.Errorf("name = %q, want %q", got, want)
	}
	if got, want := ks.GetNamespace(), "prod"; got != want {
		t.Errorf("namespace = %q, want %q", got, want)
	}

	group, _, err := unstructured.NestedString(ks.Object, "spec", "consumerGroup")
	if err != nil {
		t.Fatalf("consumerGroup: %v", err)
	}
	if want := "shop-revalidation"; group != want {
		t.Errorf("consumerGroup = %q, want %q", group, want)
	}

	topics, _, err := unstructured.NestedStringSlice(ks.Object, "spec", "topics")
	if err != nil {
		t.Fatalf("topics: %v", err)
	}
	if len(topics) != 1 || topics[0] != "shop-revalidation" {
		t.Errorf("topics = %v, want [shop-revalidation]", topics)
	}

	brokers, _, err := unstructured.NestedStringSlice(ks.Object, "spec", "bootstrapServers")
	if err != nil {
		t.Fatalf("bootstrapServers: %v", err)
	}
	if len(brokers) != 1 || brokers[0] != "kafka-broker:9092" {
		t.Errorf("bootstrapServers = %v, want [kafka-broker:9092]", brokers)
	}

	// The sink is the unbuilt consumer — the exact reason the caller is gated.
	// Pinning it here documents what shipping that consumer must be named.
	sinkKind, _, _ := unstructured.NestedString(ks.Object, "spec", "sink", "ref", "kind")
	sinkAPI, _, _ := unstructured.NestedString(ks.Object, "spec", "sink", "ref", "apiVersion")
	sinkName, _, _ := unstructured.NestedString(ks.Object, "spec", "sink", "ref", "name")
	if sinkKind != "Service" || sinkAPI != "serving.knative.dev/v1" || sinkName != "shop-revalidator" {
		t.Errorf("sink.ref = %s/%s %q, want serving.knative.dev/v1 Service \"shop-revalidator\"",
			sinkAPI, sinkKind, sinkName)
	}
}
