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
//
//	go run ./cmd/policygen -function fn -zone zone -image IMG -namespace ns
//	  (the zone function's ServiceAccount, Knative Service and NetworkPolicy,
//	  for the drill's Calico scale-from-zero leg)
package main

import (
	"flag"
	"fmt"
	"os"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer/json"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/controller"
)

func main() {
	app := flag.String("app", "", "app (NextApp/ksvc) name — renders the NextApp policy")
	function := flag.String("function", "", "zone function (BackendService) name — renders the function's "+
		"ServiceAccount, Knative Service and NetworkPolicy instead")
	zone := flag.String("zone", "", "the function's zone (NextApp name); required with -function")
	image := flag.String("image", "", "the function's image; required with -function")
	port := flag.Int("port", 8080, "the function's h2c container port")
	namespace := flag.String("namespace", "default", "namespace")
	flag.Parse()

	ser := json.NewSerializerWithOptions(
		json.DefaultMetaFactory, runtime.NewScheme(), runtime.NewScheme(),
		json.SerializerOptions{Yaml: true},
	)
	encode := func(obj runtime.Object) {
		if err := ser.Encode(obj, os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "policygen: encode failed: %v\n", err)
			os.Exit(1)
		}
	}

	switch {
	case *function != "":
		if *zone == "" || *image == "" {
			fmt.Fprintln(os.Stderr, "policygen: -function needs -zone and -image")
			os.Exit(2)
		}
		bs := &appsv1alpha1.BackendService{
			ObjectMeta: metav1.ObjectMeta{Name: *function, Namespace: *namespace},
			Spec: appsv1alpha1.BackendServiceSpec{
				Zone: *zone, Image: *image, Port: int32(*port), ProtoVersion: "1.0.0",
			},
		}
		objs, err := controller.RenderFunctionObjects(bs, 0)
		if err != nil {
			fmt.Fprintf(os.Stderr, "policygen: render failed: %v\n", err)
			os.Exit(1)
		}
		for i, obj := range objs {
			if i > 0 {
				fmt.Println("---")
			}
			encode(obj)
		}
	case *app != "":
		encode(controller.DesiredNetworkPolicy(*app, *namespace))
	default:
		fmt.Fprintln(os.Stderr, "policygen: -app or -function is required")
		os.Exit(2)
	}
}
