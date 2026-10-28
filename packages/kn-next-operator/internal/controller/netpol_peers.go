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
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	// namespaceMetadataNameLabel is the immutable Namespace label Kubernetes 1.21+
	// populates with the Namespace's own name.
	namespaceMetadataNameLabel = "kubernetes.io/metadata.name"

	// Pinned Knative Serving and Kourier namespaces and pod selector labels
	// (#2494). Guarded against upstream manifest drift by
	// TestNetworkPolicyPodLabelsPinnedAgainstUpstreamDrift.
	knativeServingNamespace = "knative-serving"
	kourierSystemNamespace  = "kourier-system"

	knativePodLabelKey          = "app"
	activatorPodLabelValue      = "activator"
	autoscalerPodLabelValue     = "autoscaler"
	kourierGatewayPodLabelKey   = "app"
	kourierGatewayPodLabelValue = "3scale-kourier-gateway"
)

// podInNamespacePeer builds a SINGLE NetworkPolicyPeer combining
// NamespaceSelector AND PodSelector on the same `from` element.
//
// Kubernetes ANDs NamespaceSelector and PodSelector only when both sit on ONE
// NetworkPolicyPeer item; splitting them into two `from` list items ORs them
// and widens the rule to every pod in the namespace plus every matching pod in
// the policy's own namespace (#2494). Panics if `namespace` or `podLabels` is
// empty so a caller can never construct a whole-namespace or all-namespaces peer.
func podInNamespacePeer(namespace string, podLabels map[string]string) networkingv1.NetworkPolicyPeer {
	if namespace == "" {
		panic("podInNamespacePeer: namespace must not be empty")
	}
	if len(podLabels) == 0 {
		panic("podInNamespacePeer: podLabels must not be empty (whole-namespace peers are forbidden)")
	}
	cloned := make(map[string]string, len(podLabels))
	for k, v := range podLabels {
		if k == "" || v == "" {
			panic("podInNamespacePeer: podLabels keys and values must not be empty")
		}
		cloned[k] = v
	}
	return networkingv1.NetworkPolicyPeer{
		NamespaceSelector: &metav1.LabelSelector{
			MatchLabels: map[string]string{
				namespaceMetadataNameLabel: namespace,
			},
		},
		PodSelector: &metav1.LabelSelector{
			MatchLabels: cloned,
		},
	}
}

func activatorPeer() networkingv1.NetworkPolicyPeer {
	return podInNamespacePeer(knativeServingNamespace, map[string]string{
		knativePodLabelKey: activatorPodLabelValue,
	})
}

func autoscalerPeer() networkingv1.NetworkPolicyPeer {
	return podInNamespacePeer(knativeServingNamespace, map[string]string{
		knativePodLabelKey: autoscalerPodLabelValue,
	})
}

func kourierGatewayPeer() networkingv1.NetworkPolicyPeer {
	return podInNamespacePeer(kourierSystemNamespace, map[string]string{
		kourierGatewayPodLabelKey: kourierGatewayPodLabelValue,
	})
}
