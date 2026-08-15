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

// policygen prints the NetworkPolicy the operator reconciles for an app.
//
// It exists so the enforcement drill (test/networkpolicy-enforcement-drill.sh)
// applies the OPERATOR's policy instead of a hand-copied YAML. Spec review
// caught that a hand-copy drifts silently: the drill would keep passing against
// a policy the operator no longer produces, which is the "guard that no longer
// guards its subject" hazard this repo has hit before. Rendering from
// controller.DesiredNetworkPolicy means any change to the real rules changes
// what the drill applies — so operator drift reddens the drill.
//
// Usage: go run ./cmd/policygen -app drill-app -namespace np-drill
package main

import (
	"flag"
	"fmt"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer/json"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/controller"
)

func main() {
	app := flag.String("app", "", "app (NextApp/ksvc) name — required")
	namespace := flag.String("namespace", "default", "namespace")
	flag.Parse()

	if *app == "" {
		fmt.Fprintln(os.Stderr, "policygen: -app is required")
		os.Exit(2)
	}

	np := controller.DesiredNetworkPolicy(*app, *namespace)
	ser := json.NewSerializerWithOptions(
		json.DefaultMetaFactory, runtime.NewScheme(), runtime.NewScheme(),
		json.SerializerOptions{Yaml: true},
	)
	if err := ser.Encode(np, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "policygen: encode failed: %v\n", err)
		os.Exit(1)
	}
}
