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
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// The objects the BackendService reconciler renders for a two-sided binding
// (ADR-0004, Amendments 1 and 2). PURE: the reconciler and cmd/policygen (the
// Calico drill's source of truth) build from these functions.

const (
	// ProtoVersionAnnotation stamps spec.protoVersion on the function's revision
	// template. The served version is read back from the latest READY
	// revision's stamp, so it never runs ahead of what actually serves.
	ProtoVersionAnnotation = "apps.kn-next.dev/proto-version"

	// FunctionJWKSVolumeName is the volume carrying the owning zone's JWKS.
	FunctionJWKSVolumeName = "knext-zone-jwks"

	// functionContainerName names the function's container.
	functionContainerName = "function"

	// defaultFunctionPort is the h2c container port when spec.port is unset.
	defaultFunctionPort = int32(8080)

	retentionAnnotation = "autoscaling.knative.dev/scale-to-zero-pod-retention-period"
	scaleDownAnnotation = "autoscaling.knative.dev/scale-down-delay"

	// functionRetentionMargin is how much longer than its zone a bound function
	// stays up after its own last call (ADR-0004 Amendment 1 Decision 3): if the
	// zone's last request called the function, the function outlasts the zone.
	functionRetentionMargin = 30 * time.Second
)

// FunctionServiceAccountName is the operator-owned ServiceAccount a function
// runs as. It never ends in "-sa", so it cannot collide with a NextApp's.
func FunctionServiceAccountName(function string) string { return function + "-function" }

// FunctionNetworkPolicyName is the function's NetworkPolicy.
func FunctionNetworkPolicyName(function string) string { return function + "-function-ingress" }

// functionLabels are stamped on every object rendered for a function.
func functionLabels(bs *appsv1alpha1.BackendService) map[string]string {
	return map[string]string{
		"app":          bs.Name,
		"generated-by": "kn-next-operator",
		ZoneLabel:      bs.Spec.Zone,
		FunctionLabel:  bs.Name,
	}
}

// functionIngressRules is the function NetworkPolicy's ingress (ADR-0004
// Amendment 2 Decision 5): the Knative serving system (the activator carries
// scale-from-zero, the autoscaler scrapes queue-proxy) and the networking
// layer's gateway namespace, on queue-proxy's ports only. These are the same
// peers and port allowlist as the NextApp policy's first rule (ADR-0044) minus
// the knext runtime's metrics port, which a function does not serve. The user
// container port is absent: queue-proxy reaches it over loopback.
//
// HONEST SCOPE. A zone's calls arrive through these shared Knative peers, so the
// policy cannot express "only the owning zone": it stops direct dials that skip
// the Knative path. The per-zone control is the identity token. Enforcement
// depends on the CNI: flannel enforces no NetworkPolicy.
func functionIngressRules() []networkingv1.NetworkPolicyIngressRule {
	return []networkingv1.NetworkPolicyIngressRule{{
		Ports: []networkingv1.NetworkPolicyPort{
			{Port: ptr.To(intstr.FromInt32(queueProxyHTTPPort))},
			{Port: ptr.To(intstr.FromInt32(queueProxyH2CPort))},
			{Port: ptr.To(intstr.FromInt32(queueProxyHTTPSPort))},
			{Port: ptr.To(intstr.FromInt32(queueProxyMetricsPort))},
		},
		From: []networkingv1.NetworkPolicyPeer{
			inNamespaceLabelsPeer("knative-serving", "kourier-system"),
		},
	}}
}

// DesiredFunctionNetworkPolicy renders the function's NetworkPolicy. Exported
// for cmd/policygen, so the Calico drill applies exactly what the reconciler
// writes.
func DesiredFunctionNetworkPolicy(function, zone, namespace string) *networkingv1.NetworkPolicy {
	bs := &appsv1alpha1.BackendService{
		ObjectMeta: metav1.ObjectMeta{Name: function, Namespace: namespace},
		Spec:       appsv1alpha1.BackendServiceSpec{Zone: zone},
	}
	return &networkingv1.NetworkPolicy{
		TypeMeta: metav1.TypeMeta{APIVersion: "networking.k8s.io/v1", Kind: "NetworkPolicy"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      FunctionNetworkPolicyName(function),
			Namespace: namespace,
			Labels:    functionLabels(bs),
		},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{
				MatchLabels: map[string]string{"serving.knative.dev/service": function},
			},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress:     functionIngressRules(),
		},
	}
}

// zoneRetention reads how long the zone's last pod stays up after traffic
// stops, from the zone's RENDERED Knative Service (so the platform merge and
// the preview override are already applied). Unparseable or absent values
// count as zero.
func zoneRetention(zoneKsvc *servingv1.Service) time.Duration {
	if zoneKsvc == nil {
		return 0
	}
	anns := zoneKsvc.Spec.Template.Annotations
	return validation.LongestRenderedRetention(anns[scaleDownAnnotation], anns[retentionAnnotation])
}

// functionPort is the h2c container port.
func functionPort(bs *appsv1alpha1.BackendService) int32 {
	if bs.Spec.Port > 0 {
		return bs.Spec.Port
	}
	return defaultFunctionPort
}

// buildFunctionKsvc mutates ksvc toward the function's desired state. The
// caller sets the controller reference.
func buildFunctionKsvc(bs *appsv1alpha1.BackendService, retention time.Duration, ksvc *servingv1.Service) error {
	if ksvc.Labels == nil {
		ksvc.Labels = map[string]string{}
	}
	for k, v := range functionLabels(bs) {
		ksvc.Labels[k] = v
	}
	// Cluster-local: no public ingress, ever (ADR-0004).
	ksvc.Labels["networking.knative.dev/visibility"] = VisibilityClusterLocalLabelValue

	annotations := map[string]string{
		"autoscaling.knative.dev/min-scale": "0",
		retentionAnnotation:                 (retention + functionRetentionMargin).String(),
	}
	if s := bs.Spec.Scaling; s != nil {
		annotations["autoscaling.knative.dev/min-scale"] = fmt.Sprintf("%d", s.MinScale)
		if s.MaxScale > 0 {
			annotations["autoscaling.knative.dev/max-scale"] = fmt.Sprintf("%d", s.MaxScale)
		}
	}
	if bs.Spec.ProtoVersion != "" {
		annotations[ProtoVersionAnnotation] = bs.Spec.ProtoVersion
	}
	ksvc.Spec.Template.Annotations = annotations
	ksvc.Spec.Template.Labels = map[string]string{ZoneLabel: bs.Spec.Zone, FunctionLabel: bs.Name}

	resources, err := functionResources(bs.Spec.Resources)
	if err != nil {
		return err
	}

	volumes := []corev1.Volume{{
		Name: FunctionJWKSVolumeName,
		VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
			LocalObjectReference: corev1.LocalObjectReference{Name: ZoneJWKSConfigMapName(bs.Spec.Zone)},
			Items:                []corev1.KeyToPath{{Key: ZoneJWKSFileName, Path: ZoneJWKSFileName}},
			// Optional until the zone identity exists: the pod starts, and the
			// function's interceptor refuses every RPC except health (fail closed).
			Optional: ptr.To(true),
		}},
	}}
	// A directory mount, never a subPath, so a rotated JWKS propagates.
	mounts := []corev1.VolumeMount{{Name: FunctionJWKSVolumeName, MountPath: ZoneJWKSMountDir, ReadOnly: true}}
	for _, v := range bs.Spec.Volumes {
		vol := corev1.Volume{Name: v.Name}
		switch {
		case v.Secret != nil:
			vol.Secret = v.Secret.DeepCopy()
		case v.ConfigMap != nil:
			vol.ConfigMap = v.ConfigMap.DeepCopy()
		case v.EmptyDir != nil:
			vol.EmptyDir = v.EmptyDir.DeepCopy()
		case v.Projected != nil:
			p := &corev1.ProjectedVolumeSource{DefaultMode: v.Projected.DefaultMode}
			for _, s := range v.Projected.Sources {
				p.Sources = append(p.Sources, corev1.VolumeProjection{
					Secret:    s.Secret.DeepCopy(),
					ConfigMap: s.ConfigMap.DeepCopy(),
				})
			}
			vol.Projected = p
		}
		volumes = append(volumes, vol)
		mounts = append(mounts, corev1.VolumeMount{Name: v.Name, MountPath: v.MountPath, ReadOnly: v.EmptyDir == nil})
	}

	spec := &ksvc.Spec.Template.Spec
	// The operator-owned ServiceAccount, always (ADR-0004 Amendment 2 Decision
	// 4): the spec has no field that could name another one.
	spec.ServiceAccountName = FunctionServiceAccountName(bs.Name)
	spec.AutomountServiceAccountToken = ptr.To(false)
	if s := bs.Spec.Scaling; s != nil && s.ContainerConcurrency > 0 {
		cc := int64(s.ContainerConcurrency)
		spec.ContainerConcurrency = &cc
	} else {
		spec.ContainerConcurrency = nil
	}
	spec.Volumes = volumes
	spec.Containers = []corev1.Container{{
		Name:         functionContainerName,
		Image:        bs.Spec.Image,
		Ports:        []corev1.ContainerPort{{Name: "h2c", ContainerPort: functionPort(bs)}},
		Env:          append([]corev1.EnvVar(nil), bs.Spec.Env...),
		EnvFrom:      append([]corev1.EnvFromSource(nil), bs.Spec.EnvFrom...),
		VolumeMounts: mounts,
		Resources:    resources,
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: ptr.To(false),
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
	}}
	// No traffic split: a function always serves its latest Ready revision, so
	// the served version is that revision's stamp.
	ksvc.Spec.Traffic = nil
	return nil
}

// RenderFunctionObjects returns the ServiceAccount, Knative Service and
// NetworkPolicy the reconciler renders for an accepted function, without owner
// references (no cluster objects are read). Exported for cmd/policygen, so the
// Calico drill applies exactly the operator's objects rather than a hand copy.
func RenderFunctionObjects(bs *appsv1alpha1.BackendService, zoneRetention time.Duration) ([]client.Object, error) {
	sa := &corev1.ServiceAccount{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "ServiceAccount"},
		ObjectMeta: metav1.ObjectMeta{
			Name: FunctionServiceAccountName(bs.Name), Namespace: bs.Namespace, Labels: functionLabels(bs),
		},
		AutomountServiceAccountToken: ptr.To(false),
		ImagePullSecrets:             bs.Spec.ImagePullSecrets,
	}
	ksvc := &servingv1.Service{
		TypeMeta:   metav1.TypeMeta{APIVersion: servingv1.SchemeGroupVersion.String(), Kind: "Service"},
		ObjectMeta: metav1.ObjectMeta{Name: bs.Name, Namespace: bs.Namespace},
	}
	if err := buildFunctionKsvc(bs, zoneRetention, ksvc); err != nil {
		return nil, err
	}
	return []client.Object{sa, ksvc, DesiredFunctionNetworkPolicy(bs.Name, bs.Spec.Zone, bs.Namespace)}, nil
}

// functionResources parses the function's requests and limits with the
// bounded parser (CR input never reaches resource.MustParse).
func functionResources(r *appsv1alpha1.ResourcesSpec) (corev1.ResourceRequirements, error) {
	var out corev1.ResourceRequirements
	if r == nil {
		return out, nil
	}
	set := func(list *corev1.ResourceList, name corev1.ResourceName, field, value string) error {
		if value == "" {
			return nil
		}
		q, err := validation.ParseQuantityBounded(value)
		if err != nil {
			return fmt.Errorf("spec.resources.%s %q is not a valid Kubernetes quantity: %w", field, value, err)
		}
		if *list == nil {
			*list = corev1.ResourceList{}
		}
		(*list)[name] = q
		return nil
	}
	for _, f := range []struct {
		list  *corev1.ResourceList
		name  corev1.ResourceName
		field string
		value string
	}{
		{&out.Requests, corev1.ResourceCPU, "cpuRequest", r.CPURequest},
		{&out.Requests, corev1.ResourceMemory, "memoryRequest", r.MemoryRequest},
		{&out.Limits, corev1.ResourceCPU, "cpuLimit", r.CPULimit},
		{&out.Limits, corev1.ResourceMemory, "memoryLimit", r.MemoryLimit},
	} {
		if err := set(f.list, f.name, f.field, f.value); err != nil {
			return out, err
		}
	}
	return out, nil
}

// VisibilityClusterLocalLabelValue is the networking.knative.dev/visibility
// value that keeps a Route off the external gateway.
const VisibilityClusterLocalLabelValue = "cluster-local"
