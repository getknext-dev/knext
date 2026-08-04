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

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// kafkaRevalidationRequested reports whether the app asks for kafka-backed ISR
// revalidation at all (spec.revalidation.queue == "kafka").
func kafkaRevalidationRequested(app *appsv1alpha1.NextApp) bool {
	return app.Spec.Revalidation != nil && app.Spec.Revalidation.Queue == "kafka"
}

// buildKafkaSource builds the Knative `KafkaSource` for an app's ISR-revalidation
// topic. Unstructured, to avoid pulling Knative Eventing's proto dependencies
// into the controller binary.
//
// NOTE (#475): no caller reaches this today. revalidationDeferred is true for
// every `queue: kafka` app because the sink below — a Knative Service named
// `{app}-revalidator` — is not built by knext and its contract (what CloudEvents
// it consumes, how it authenticates, how it calls revalidateTag) was never
// specified or tested. Shipping that consumer is the open ADR-0016 action item;
// doing so is what re-opens the call site.
//
// It is a pure builder precisely so the retained shape stays covered by a unit
// test (build_kafka_source_test.go) rather than rotting behind a dead branch.
func buildKafkaSource(app *appsv1alpha1.NextApp) *unstructured.Unstructured {
	ks := &unstructured.Unstructured{}
	ks.SetAPIVersion("sources.knative.dev/v1beta1")
	ks.SetKind("KafkaSource")
	ks.SetName(app.Name + "-revalidation-source")
	ks.SetNamespace(app.Namespace)

	var broker string
	if app.Spec.Revalidation != nil {
		broker = app.Spec.Revalidation.KafkaBrokerUrl
	}

	ks.Object["spec"] = map[string]interface{}{
		"consumerGroup": app.Name + "-revalidation",
		"bootstrapServers": []interface{}{
			broker,
		},
		"topics": []interface{}{
			fmt.Sprintf("%s-revalidation", app.Name),
		},
		"sink": map[string]interface{}{
			"ref": map[string]interface{}{
				"apiVersion": "serving.knative.dev/v1",
				"kind":       "Service",
				"name":       app.Name + "-revalidator",
			},
		},
	}
	return ks
}
