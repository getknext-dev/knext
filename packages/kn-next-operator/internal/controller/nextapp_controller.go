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
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// Condition type constants used across the reconciler.
const (
	// ConditionReconciling indicates the operator is actively reconciling the resource.
	ConditionReconciling = "Reconciling"
	// ConditionReady indicates the NextApp Knative Service is available.
	ConditionReady = "Ready"
	// ConditionDegraded indicates the reconciliation failed or the resource is unhealthy.
	ConditionDegraded = "Degraded"
)

// Event reason constants — concise, stable strings surfaced via `kubectl describe nextapp`.
const (
	// ReasonInvalidImage marks a NextApp rejected for failing digest-pinning (e.g. :latest).
	ReasonInvalidImage = "InvalidImage"
	// ReasonReconcileFailed marks a generic reconcile error (API error, child create/update failure).
	ReasonReconcileFailed = "ReconcileFailed"
	// ReasonReconciled marks a successful reconcile.
	ReasonReconciled = "Reconciled"
)

// NextAppReconciler reconciles a NextApp object
type NextAppReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// Recorder emits Kubernetes Events attached to the NextApp so operators can see
	// reconcile transitions via `kubectl describe`. May be nil in unit tests.
	Recorder record.EventRecorder
}

// emitEvent records a Kubernetes Event on the NextApp when a recorder is wired.
func (r *NextAppReconciler) emitEvent(obj runtime.Object, eventType, reason, message string) {
	if r.Recorder != nil {
		r.Recorder.Event(obj, eventType, reason, message)
	}
}

// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=nextapps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=nextapps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=nextapps/finalizers,verbs=update
// +kubebuilder:rbac:groups=serving.knative.dev,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=caching.internal.knative.dev,resources=images,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func (r *NextAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (result ctrl.Result, retErr error) {
	logger := logf.FromContext(ctx)

	// Observe reconcile duration and tally the result on every return path.
	start := time.Now()
	defer func() {
		reconcileDuration.Observe(time.Since(start).Seconds())
		if retErr != nil {
			reconcileTotal.WithLabelValues("error").Inc()
			reconcileErrors.Inc()
		} else {
			reconcileTotal.WithLabelValues("success").Inc()
		}
	}()

	var nextApp appsv1alpha1.NextApp
	if err := r.Get(ctx, req.NamespacedName, &nextApp); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Mark Reconciling=True at the start of every reconcile loop.
	apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
		Type:               ConditionReconciling,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: nextApp.Generation,
		Reason:             "Reconciling",
		Message:            "Reconciliation in progress",
	})
	if err := r.Status().Update(ctx, &nextApp); err != nil {
		return ctrl.Result{}, err
	}

	// Validate the full spec using the SAME function the admission webhook calls
	// (internal/validation.ValidateNextAppSpec) so the two cannot drift. This
	// enforces digest pinning (rejects :latest / tag-only refs), required image,
	// non-negative scaling, MinScale <= MaxScale, and recognized provider/queue
	// enums. The webhook rejects these at write time; the reconciler stays
	// fail-closed as defense-in-depth for CRs that predate the webhook.
	if err := validation.ValidateNextAppSpec(&nextApp.Spec); err != nil {
		logger.Error(err, "Rejecting NextApp: spec failed validation")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonInvalidImage,
			fmt.Sprintf("Spec rejected: %s", err.Error()))
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionDegraded,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: nextApp.Generation,
			Reason:             "InvalidSpec",
			Message:            err.Error(),
		})
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: nextApp.Generation,
			Reason:             "InvalidSpec",
			Message:            "Spec does not meet validation requirements",
		})
		_ = r.Status().Update(ctx, &nextApp)
		return ctrl.Result{}, err
	}

	// 1. Create/Update ServiceAccount
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name + "-sa",
			Namespace: nextApp.Namespace,
		},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, sa, func() error {
		sa.AutomountServiceAccountToken = ptr.To(false)
		return ctrl.SetControllerReference(&nextApp, sa, r.Scheme)
	})
	if err != nil {
		logger.Error(err, "Failed to reconcile ServiceAccount")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
			fmt.Sprintf("Failed to reconcile ServiceAccount: %s", err.Error()))
		return ctrl.Result{}, err
	}

	// 2. Create/Update PVC if Bytecode Caching is enabled
	if nextApp.Spec.Cache != nil && nextApp.Spec.Cache.EnableBytecodeCache {
		size := nextApp.Spec.Cache.BytecodeCacheSize
		if size == "" {
			size = "512Mi"
		}
		pvc := &corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{
				Name:      nextApp.Name + "-bytecode-cache",
				Namespace: nextApp.Namespace,
			},
		}
		_, err = controllerutil.CreateOrUpdate(ctx, r.Client, pvc, func() error {
			if pvc.Spec.AccessModes == nil {
				pvc.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
			}
			if pvc.Spec.Resources.Requests == nil {
				pvc.Spec.Resources.Requests = corev1.ResourceList{}
			}
			pvc.Spec.Resources.Requests[corev1.ResourceStorage] = resource.MustParse(size)
			return ctrl.SetControllerReference(&nextApp, pvc, r.Scheme)
		})
		if err != nil {
			logger.Error(err, "Failed to reconcile PVC")
			r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
				fmt.Sprintf("Failed to reconcile bytecode-cache PVC: %s", err.Error()))
			return ctrl.Result{}, err
		}
	}

	// 3. Create/Update Image Cache (pre-pull for faster cold starts)
	imageCache := &unstructured.Unstructured{}
	imageCache.SetAPIVersion("caching.internal.knative.dev/v1alpha1")
	imageCache.SetKind("Image")
	imageCache.SetName(nextApp.Name + "-image-cache")
	imageCache.SetNamespace(nextApp.Namespace)

	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, imageCache, func() error {
		imageCache.Object["spec"] = map[string]interface{}{
			"image": nextApp.Spec.Image,
		}
		labels := map[string]string{
			"app":          nextApp.Name,
			"generated-by": "kn-next-operator",
		}
		imageCache.SetLabels(labels)
		return ctrl.SetControllerReference(&nextApp, imageCache, r.Scheme)
	})
	if err != nil {
		// Image cache is non-critical — log and continue
		logger.Info("Could not reconcile Image cache (CRD may not be installed)", "error", err.Error())
	}

	// Determine health check path
	healthPath := "/api/health"
	if nextApp.Spec.HealthCheckPath != "" {
		healthPath = nextApp.Spec.HealthCheckPath
	}

	// 4. Create/Update Knative Service
	ksvc := &servingv1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name,
			Namespace: nextApp.Namespace,
		},
	}
	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, ksvc, func() error {
		if ksvc.Labels == nil {
			ksvc.Labels = make(map[string]string)
		}
		ksvc.Labels["app"] = nextApp.Name
		ksvc.Labels["generated-by"] = "kn-next-operator"

		annotations := map[string]string{
			"autoscaling.knative.dev/min-scale": "0",
			"autoscaling.knative.dev/max-scale": "10",
		}
		if nextApp.Spec.Scaling != nil {
			annotations["autoscaling.knative.dev/min-scale"] = fmt.Sprintf("%d", nextApp.Spec.Scaling.MinScale)
			annotations["autoscaling.knative.dev/max-scale"] = fmt.Sprintf("%d", nextApp.Spec.Scaling.MaxScale)
		}

		// Observability annotations — aligned with CLI
		if nextApp.Spec.Observability != nil && nextApp.Spec.Observability.Enabled {
			annotations["prometheus.io/scrape"] = "true"
			annotations["prometheus.io/port"] = "9091"
			annotations["prometheus.io/path"] = "/metrics"
		}

		if nextApp.Spec.Preview != nil && nextApp.Spec.Preview.Enabled {
			ksvc.Labels["environment"] = "preview"
			ksvc.Labels["pr-id"] = nextApp.Spec.Preview.PRID

			// Override max-scale to 1 to save cluster resources on previews
			annotations["autoscaling.knative.dev/max-scale"] = "1"
			annotations["autoscaling.knative.dev/min-scale"] = "0"
			// Set a very short scale-to-zero window
			annotations["autoscaling.knative.dev/scale-to-zero-pod-retention-period"] = "30s"
		}

		var envVars []corev1.EnvVar
		envVars = append(envVars, corev1.EnvVar{Name: "HOSTNAME", Value: "0.0.0.0"})
		envVars = append(envVars, corev1.EnvVar{Name: "NODE_ENV", Value: "production"})

		if nextApp.Spec.Storage != nil && nextApp.Spec.Storage.Provider != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "STORAGE_PROVIDER", Value: nextApp.Spec.Storage.Provider})
			envVars = append(envVars, corev1.EnvVar{Name: "GCS_BUCKET_NAME", Value: nextApp.Spec.Storage.Bucket})
			// S3/MinIO provider fields — aligned with CLI knative-manifest.ts storageEnvVarGenerators
			if nextApp.Spec.Storage.Region != "" {
				envVars = append(envVars, corev1.EnvVar{Name: "CACHE_BUCKET_REGION", Value: nextApp.Spec.Storage.Region})
			}
			if nextApp.Spec.Storage.Endpoint != "" {
				envVars = append(envVars, corev1.EnvVar{Name: "S3_ENDPOINT", Value: nextApp.Spec.Storage.Endpoint})
			}
		}
		if nextApp.Spec.Cache != nil && nextApp.Spec.Cache.Provider != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "CACHE_PROVIDER", Value: nextApp.Spec.Cache.Provider})
			envVars = append(envVars, corev1.EnvVar{Name: "REDIS_URL", Value: nextApp.Spec.Cache.URL})
			if nextApp.Spec.Cache.KeyPrefix != "" {
				envVars = append(envVars, corev1.EnvVar{Name: "REDIS_KEY_PREFIX", Value: nextApp.Spec.Cache.KeyPrefix})
			}
			if nextApp.Spec.Cache.EnableBytecodeCache {
				envVars = append(envVars, corev1.EnvVar{Name: "NODE_COMPILE_CACHE", Value: "/cache/bytecode/latest"})
			}
		}
		if nextApp.Spec.Revalidation != nil && nextApp.Spec.Revalidation.Queue != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "KAFKA_BROKER_URL", Value: nextApp.Spec.Revalidation.KafkaBrokerUrl})
			envVars = append(envVars, corev1.EnvVar{Name: "KAFKA_REVALIDATION_TOPIC", Value: fmt.Sprintf("%s-revalidation", nextApp.Name)})
		}

		// Observability env vars — aligned with CLI
		if nextApp.Spec.Observability != nil && nextApp.Spec.Observability.Enabled {
			envVars = append(envVars, corev1.EnvVar{Name: "KN_APP_NAME", Value: nextApp.Name})
		}

		var envFrom []corev1.EnvFromSource
		if nextApp.Spec.Secrets != nil {
			// envFrom: inject entire secrets as env vars
			for _, secretName := range nextApp.Spec.Secrets.EnvFrom {
				envFrom = append(envFrom, corev1.EnvFromSource{
					SecretRef: &corev1.SecretEnvSource{
						LocalObjectReference: corev1.LocalObjectReference{Name: secretName},
					},
				})
			}
			// envMap: map specific secret keys to env var names — aligned with CLI
			for envName, entry := range nextApp.Spec.Secrets.EnvMap {
				envVars = append(envVars, corev1.EnvVar{
					Name: envName,
					ValueFrom: &corev1.EnvVarSource{
						SecretKeyRef: &corev1.SecretKeySelector{
							LocalObjectReference: corev1.LocalObjectReference{Name: entry.SecretName},
							Key:                  entry.SecretKey,
						},
					},
				})
			}
		}

		var volumes []corev1.Volume
		var volumeMounts []corev1.VolumeMount
		if nextApp.Spec.Cache != nil && nextApp.Spec.Cache.EnableBytecodeCache {
			volumes = append(volumes, corev1.Volume{
				Name: "bytecode-cache",
				VolumeSource: corev1.VolumeSource{
					PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
						ClaimName: nextApp.Name + "-bytecode-cache",
					},
				},
			})
			volumeMounts = append(volumeMounts, corev1.VolumeMount{
				Name:      "bytecode-cache",
				MountPath: "/cache/bytecode",
			})
		}

		cc := int64(100)
		if nextApp.Spec.Scaling != nil && nextApp.Spec.Scaling.ContainerConcurrency > 0 {
			cc = int64(nextApp.Spec.Scaling.ContainerConcurrency)
		}

		// Resource limits — aligned with CLI defaults
		resourceRequests := corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("250m"),
			corev1.ResourceMemory: resource.MustParse("512Mi"),
		}
		resourceLimits := corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("1000m"),
			corev1.ResourceMemory: resource.MustParse("1Gi"),
		}
		if nextApp.Spec.Resources != nil {
			if nextApp.Spec.Resources.CPURequest != "" {
				resourceRequests[corev1.ResourceCPU] = resource.MustParse(nextApp.Spec.Resources.CPURequest)
			}
			if nextApp.Spec.Resources.MemoryRequest != "" {
				resourceRequests[corev1.ResourceMemory] = resource.MustParse(nextApp.Spec.Resources.MemoryRequest)
			}
			if nextApp.Spec.Resources.CPULimit != "" {
				resourceLimits[corev1.ResourceCPU] = resource.MustParse(nextApp.Spec.Resources.CPULimit)
			}
			if nextApp.Spec.Resources.MemoryLimit != "" {
				resourceLimits[corev1.ResourceMemory] = resource.MustParse(nextApp.Spec.Resources.MemoryLimit)
			}
		}

		// TimeoutSeconds: default 300s when unset (matches knative-manifest.ts hardcoded value)
		timeoutSeconds := int64(300)
		if nextApp.Spec.TimeoutSeconds > 0 {
			timeoutSeconds = int64(nextApp.Spec.TimeoutSeconds)
		}

		// Runtime: select bun or node to exec server.js
		var containerCommand []string
		if nextApp.Spec.Runtime == "bun" {
			containerCommand = []string{"bun", "run", "server.js"}
		}

		ksvc.Spec.Template.ObjectMeta.Annotations = annotations
		ksvc.Spec.Template.Spec.ServiceAccountName = nextApp.Name + "-sa"
		ksvc.Spec.Template.Spec.ContainerConcurrency = &cc
		ksvc.Spec.Template.Spec.TimeoutSeconds = &timeoutSeconds
		ksvc.Spec.Template.Spec.Containers = []corev1.Container{
			{
				Image:        nextApp.Spec.Image,
				Command:      containerCommand,
				Env:          envVars,
				EnvFrom:      envFrom,
				VolumeMounts: volumeMounts,
				Ports: []corev1.ContainerPort{
					{ContainerPort: 3000},
				},
				Resources: corev1.ResourceRequirements{
					Requests: resourceRequests,
					Limits:   resourceLimits,
				},
				// Probe values aligned with CLI: initialDelay=2, period=3 for readiness
				ReadinessProbe: &corev1.Probe{
					ProbeHandler: corev1.ProbeHandler{
						HTTPGet: &corev1.HTTPGetAction{
							Path: healthPath,
							Port: intstr.FromInt(3000),
						},
					},
					InitialDelaySeconds: 2,
					PeriodSeconds:       3,
				},
				LivenessProbe: &corev1.Probe{
					ProbeHandler: corev1.ProbeHandler{
						HTTPGet: &corev1.HTTPGetAction{
							Path: healthPath,
							Port: intstr.FromInt(3000),
						},
					},
					InitialDelaySeconds: 5,
					PeriodSeconds:       10,
				},
			},
		}
		ksvc.Spec.Template.Spec.Volumes = volumes

		return ctrl.SetControllerReference(&nextApp, ksvc, r.Scheme)
	})
	if err != nil {
		logger.Error(err, "Failed to reconcile Knative Service")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
			fmt.Sprintf("Failed to reconcile Knative Service: %s", err.Error()))
		return ctrl.Result{}, err
	}

	// 5. Create/Update KafkaSource if Revalidation is enabled using Unstructured to avoid Eventing proto deps
	if nextApp.Spec.Revalidation != nil && nextApp.Spec.Revalidation.Queue == "kafka" {
		topic := fmt.Sprintf("%s-revalidation", nextApp.Name)
		kafkaSource := &unstructured.Unstructured{}
		kafkaSource.SetAPIVersion("sources.knative.dev/v1beta1")
		kafkaSource.SetKind("KafkaSource")
		kafkaSource.SetName(nextApp.Name + "-revalidation-source")
		kafkaSource.SetNamespace(nextApp.Namespace)

		_, err = controllerutil.CreateOrUpdate(ctx, r.Client, kafkaSource, func() error {
			spec := map[string]interface{}{
				"consumerGroup": nextApp.Name + "-revalidation",
				"bootstrapServers": []interface{}{
					nextApp.Spec.Revalidation.KafkaBrokerUrl,
				},
				"topics": []interface{}{
					topic,
				},
				"sink": map[string]interface{}{
					"ref": map[string]interface{}{
						"apiVersion": "serving.knative.dev/v1",
						"kind":       "Service",
						"name":       nextApp.Name + "-revalidator",
					},
				},
			}
			kafkaSource.Object["spec"] = spec
			return ctrl.SetControllerReference(&nextApp, kafkaSource, r.Scheme)
		})
		if err != nil {
			logger.Error(err, "Failed to reconcile KafkaSource")
			r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
				fmt.Sprintf("Failed to reconcile KafkaSource: %s", err.Error()))
			return ctrl.Result{}, err
		}
	}

	// 6. Update Status: URL + conditions
	if ksvc.Status.URL != nil {
		nextApp.Status.URL = ksvc.Status.URL.String()
	}

	// Reconcile succeeded — set Ready=True, Reconciling=False, Degraded=False.
	apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
		Type:               ConditionReady,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: nextApp.Generation,
		Reason:             "ReconcileSuccess",
		Message:            "NextApp reconciled successfully",
	})
	apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
		Type:               ConditionReconciling,
		Status:             metav1.ConditionFalse,
		ObservedGeneration: nextApp.Generation,
		Reason:             "ReconcileSuccess",
		Message:            "Reconciliation complete",
	})
	apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
		Type:               ConditionDegraded,
		Status:             metav1.ConditionFalse,
		ObservedGeneration: nextApp.Generation,
		Reason:             "ReconcileSuccess",
		Message:            "No errors detected",
	})
	if err := r.Status().Update(ctx, &nextApp); err != nil {
		return ctrl.Result{}, err
	}

	r.emitEvent(&nextApp, corev1.EventTypeNormal, ReasonReconciled,
		fmt.Sprintf("NextApp reconciled successfully (image %s)", nextApp.Spec.Image))
	logger.Info("Successfully reconciled NextApp", "name", nextApp.Name, "url", nextApp.Status.URL)
	return ctrl.Result{}, nil
}

func (r *NextAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&appsv1alpha1.NextApp{}).
		Owns(&servingv1.Service{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Owns(&corev1.ServiceAccount{}).
		Named("nextapp").
		Complete(r)
}
