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

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ADR-0037 — image caching via an operator-reconciled pre-pull DaemonSet.
//
// When spec.scaling.imagePrewarm is true the operator reconciles a DaemonSet
// `<app>-imgcache` that pulls and PINS the app's digest-pinned image on every
// schedulable node, so scale-from-zero never waits on the ~2 s image pull.
//
// DISTROLESS-SAFETY (the sign-off-blocking invariant): knext runtime images are
// distroless/Alpine and may have no /bin/sh — a `sleep infinity` main command on
// the app image would CrashLoopBackOff. So the DaemonSet keeps the app image
// both PULLED and PINNED against containerd GC WITHOUT executing the app or
// relying on the image's own binaries:
//
//   - an initContainer (the helper image, guaranteed to ship a static busybox)
//     copies that static binary into a shared emptyDir;
//   - the MAIN container runs the APP IMAGE with `command` pointing at the copied
//     static binary (busybox sleep) — forcing kubelet to PULL the app image and
//     keeping a RUNNING container that references the app digest (so image GC
//     never evicts it), while the app server never boots.
//
// A bare pause container is insufficient: it pins only the pause image, not the
// app image. A *running* container must reference the app digest.

// ConditionImageCacheReady surfaces (non-fatally) whether the image-prewarm
// DaemonSet has the app image pulled+pinned on every node it targets (ADR-0037).
// It never gates the app's Ready condition — a not-yet-cached prewarmer only
// means the first cold start on those nodes still pays the pull, exactly as
// without prewarm.
const ConditionImageCacheReady = "ImageCacheReady"

// prewarmHelperImage is the tiny, static-binary image the initContainer uses to
// stage a shell-free `sleep` into the shared emptyDir. It is an OPERATOR-owned
// helper (NOT the app image). Digest-pinned per security.md / CLAUDE.md §7 — the
// operator digest-pins every image it runs, and this helper is no exception
// (#471). The human-readable tag is retained alongside the digest for legibility;
// the digest is what kubelet resolves. To bump: `crane digest busybox:<tag>`.
const prewarmHelperImage = "busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662"

// prewarmHelperMountPath is where the shared emptyDir carrying the copied static
// helper binary is mounted in BOTH the initContainer and the main container.
const prewarmHelperMountPath = "/knext-pin"

// prewarmHelperBinary is the path of the static helper binary inside the shared
// emptyDir (busybox copied there by the initContainer).
const prewarmHelperBinary = prewarmHelperMountPath + "/busybox"

// prewarmNonRootUID is a non-root uid the static busybox helper runs as. busybox
// is a static multi-call binary with no per-user requirements, so any non-zero
// uid works; 65532 matches the common "nonroot" distroless uid.
const prewarmNonRootUID int64 = 65532

// imagePrewarmEnabled reports whether the app opted into node-local image
// pre-pull (ADR-0037): spec.scaling.imagePrewarm == true.
func imagePrewarmEnabled(app *appsv1alpha1.NextApp) bool {
	return app.Spec.Scaling != nil && app.Spec.Scaling.ImagePrewarm
}

// buildImagePrewarmDaemonSet is the PURE builder for the `<app>-imgcache`
// DaemonSet (ADR-0037). It never sets an owner reference (the reconcile wrapper
// does that via controllerutil) — keeping it unit-testable without a scheme.
func buildImagePrewarmDaemonSet(app *appsv1alpha1.NextApp, pullSecrets []corev1.LocalObjectReference) *appsv1.DaemonSet {
	labels := map[string]string{
		"app":                          app.Name,
		"generated-by":                 "kn-next-operator",
		"apps.kn-next.dev/imgcache":    app.Name,
		"app.kubernetes.io/component":  "image-prewarm",
		"app.kubernetes.io/managed-by": "kn-next-operator",
	}

	tiny := corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("1m"),
		corev1.ResourceMemory: resource.MustParse("16Mi"),
	}

	containerSC := &corev1.SecurityContext{
		RunAsNonRoot:             ptr.To(true),
		RunAsUser:                ptr.To(prewarmNonRootUID),
		ReadOnlyRootFilesystem:   ptr.To(true),
		AllowPrivilegeEscalation: ptr.To(false),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
	}

	helperMount := corev1.VolumeMount{Name: "pin", MountPath: prewarmHelperMountPath}

	ds := &appsv1.DaemonSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      app.Name + "-imgcache",
			Namespace: app.Namespace,
			Labels:    labels,
		},
		Spec: appsv1.DaemonSetSpec{
			Selector: &metav1.LabelSelector{
				MatchLabels: map[string]string{"apps.kn-next.dev/imgcache": app.Name},
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					// No API access needed: never mount a SA token.
					AutomountServiceAccountToken: ptr.To(false),
					// The pin process is a bare `busybox sleep` (PID 1, no SIGTERM
					// handler), so the default 30s grace would delay every digest
					// rollout / disable by 30s per node. Drop it to 1s.
					TerminationGracePeriodSeconds: ptr.To(int64(1)),
					// Pull the app image on EVERY node, tainted ones included.
					Tolerations:      []corev1.Toleration{{Operator: corev1.TolerationOpExists}},
					ImagePullSecrets: pullSecrets,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot:   ptr.To(true),
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Volumes: []corev1.Volume{
						{Name: "pin", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
					},
					// initContainer stages the static busybox helper into the
					// shared emptyDir. `cp` preserves the executable mode.
					InitContainers: []corev1.Container{
						{
							Name:            "stage-pin",
							Image:           prewarmHelperImage,
							Command:         []string{"cp", "/bin/busybox", prewarmHelperBinary},
							VolumeMounts:    []corev1.VolumeMount{helperMount},
							SecurityContext: containerSC,
							Resources:       corev1.ResourceRequirements{Requests: tiny},
						},
					},
					// MAIN container runs the APP IMAGE (forcing the pull + pinning
					// the digest against GC) but execs ONLY the copied static
					// busybox — the app server never boots and no shell is assumed.
					Containers: []corev1.Container{
						{
							Name:            "pin",
							Image:           app.Spec.Image,
							Command:         []string{prewarmHelperBinary, "sleep", "2147483647"},
							VolumeMounts:    []corev1.VolumeMount{helperMount},
							SecurityContext: containerSC,
							Resources:       corev1.ResourceRequirements{Requests: tiny},
						},
					},
				},
			},
		},
	}
	return ds
}

// reconcileImagePrewarmDaemonSet creates/updates the `<app>-imgcache` DaemonSet
// when spec.scaling.imagePrewarm is true, and deletes it (idempotently) when
// unset/false. Mirrors the shape of reconcileBytecodeCachePVC / reconcileNetworkPolicy.
func (r *NextAppReconciler) reconcileImagePrewarmDaemonSet(ctx context.Context, nextApp *appsv1alpha1.NextApp) error {
	ds := &appsv1.DaemonSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name + "-imgcache",
			Namespace: nextApp.Namespace,
		},
	}

	if !imagePrewarmEnabled(nextApp) {
		// Disabled: best-effort delete of any previously-created DaemonSet.
		if err := r.Delete(ctx, ds); err != nil && !errors.IsNotFound(err) {
			return err
		}
		return nil
	}

	// imagePullSecrets "from the app": the app's ServiceAccount (`<app>-sa`) is
	// what Knative uses to pull the app image, so the prewarmer inherits the same
	// pull credentials. A missing SA (should not happen — reconciled just above)
	// or one without secrets yields an empty list (node-level creds then apply,
	// exactly as for the ksvc).
	pullSecrets := r.appImagePullSecrets(ctx, nextApp)

	desired := buildImagePrewarmDaemonSet(nextApp, pullSecrets)
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, ds, func() error {
		ds.Labels = desired.Labels
		// Selector is immutable once set; only assign when empty (create path).
		if ds.Spec.Selector == nil {
			ds.Spec.Selector = desired.Spec.Selector
		}
		ds.Spec.Template = desired.Spec.Template
		return ctrl.SetControllerReference(nextApp, ds, r.Scheme)
	})
	return err
}

// appImagePullSecrets reads the app's ServiceAccount imagePullSecrets so the
// prewarmer pulls with the same credentials as the app (ADR-0037). Best-effort:
// a missing/unreadable SA returns nil (node-level creds then apply).
func (r *NextAppReconciler) appImagePullSecrets(ctx context.Context, nextApp *appsv1alpha1.NextApp) []corev1.LocalObjectReference {
	sa := &corev1.ServiceAccount{}
	key := client.ObjectKey{Namespace: nextApp.Namespace, Name: nextApp.Name + "-sa"}
	if err := r.Get(ctx, key, sa); err != nil {
		return nil
	}
	return sa.ImagePullSecrets
}

// imageCacheState carries the observed readiness of the prewarm DaemonSet into
// the pure status verdict (ADR-0037). enabled mirrors imagePrewarmEnabled;
// desired/ready mirror the DaemonSet's DesiredNumberScheduled / NumberReady.
type imageCacheState struct {
	enabled bool
	desired int32
	ready   int32
}
