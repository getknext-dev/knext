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
	corev1 "k8s.io/api/core/v1"
	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// restrictedContainerSecurityContext is the container securityContext every
// operator-rendered serving container carries, so the pod is admitted in a
// namespace that enforces the Kubernetes Pod Security `restricted` level:
//
//   - allowPrivilegeEscalation: false  (no setuid / file-capability gain)
//   - capabilities.drop: [ALL]         (nothing added back; the apps listen on
//     unprivileged ports)
//   - seccompProfile: RuntimeDefault   (the container runtime's syscall filter)
//   - runAsNonRoot: true               (unless the NextApp opts out, see below)
//
// It is rendered on the CONTAINER and never on the pod. Knative's ksvc webhook
// rejects a pod-level securityContext on a stock install (it needs the
// non-default `kubernetes.podspec-securitycontext` feature flag), while the
// container-level fields above are always accepted; the restricted profile
// accepts either level. The queue-proxy sidecar Knative adds already carries
// the same four fields itself.
//
// runAsUser is deliberately NOT set. Forcing a uid would override the image's
// own and quietly break an image whose files belong to a different non-root
// user; with only runAsNonRoot set, the kubelet refuses the container when the
// image would run as root or names its user instead of a number, and the
// failure names the cause.
//
// readOnlyRootFS is passed through unchanged (nil leaves it unset): it is its
// own knob (spec.security.readOnlyRootFilesystem for an app) and not part of
// the restricted profile.
func restrictedContainerSecurityContext(readOnlyRootFS *bool, runAsNonRoot bool) *corev1.SecurityContext {
	sc := &corev1.SecurityContext{
		ReadOnlyRootFilesystem:   readOnlyRootFS,
		AllowPrivilegeEscalation: ptr.To(false),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
	}
	if runAsNonRoot {
		sc.RunAsNonRoot = ptr.To(true)
	}
	return sc
}

// nextAppRunAsNonRoot resolves spec.security.runAsNonRoot: nil (unset) and true
// both render `runAsNonRoot: true` (DEFAULT-ON, the same nil-means-true
// convention as spec.security.readOnlyRootFilesystem); only an explicit false
// omits it.
func nextAppRunAsNonRoot(s *appsv1alpha1.SecuritySpec) bool {
	return s == nil || s.RunAsNonRoot == nil || *s.RunAsNonRoot
}
