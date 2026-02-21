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

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	appsv1alpha1 "github.com/AhmedElBanna80/Knative-open-nextjs/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// NextAppReconciler reconciles a NextApp object
type NextAppReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=nextapps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=nextapps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=nextapps/finalizers,verbs=update
// +kubebuilder:rbac:groups=serving.knative.dev,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete

func (r *NextAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := logf.FromContext(ctx)

	var nextApp appsv1alpha1.NextApp
	if err := r.Get(ctx, req.NamespacedName, &nextApp); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
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
			return ctrl.Result{}, err
		}
	}

	// 3. Create/Update Knative Service
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
		}
		if nextApp.Spec.Cache != nil && nextApp.Spec.Cache.Provider != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "CACHE_PROVIDER", Value: nextApp.Spec.Cache.Provider})
			envVars = append(envVars, corev1.EnvVar{Name: "REDIS_URL", Value: nextApp.Spec.Cache.URL})
			if nextApp.Spec.Cache.EnableBytecodeCache {
				envVars = append(envVars, corev1.EnvVar{Name: "NODE_COMPILE_CACHE", Value: "/cache/bytecode/latest"})
			}
		}
		if nextApp.Spec.Revalidation != nil && nextApp.Spec.Revalidation.Queue != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "KAFKA_BROKER_URL", Value: nextApp.Spec.Revalidation.KafkaBrokerUrl})
			envVars = append(envVars, corev1.EnvVar{Name: "KAFKA_REVALIDATION_TOPIC", Value: fmt.Sprintf("%s-revalidation", nextApp.Name)})
		}

		var envFrom []corev1.EnvFromSource
		if nextApp.Spec.Secrets != nil {
			for _, secretName := range nextApp.Spec.Secrets.EnvFrom {
				envFrom = append(envFrom, corev1.EnvFromSource{
					SecretRef: &corev1.SecretEnvSource{
						LocalObjectReference: corev1.LocalObjectReference{Name: secretName},
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

		ksvc.Spec.Template.ObjectMeta.Annotations = annotations
		ksvc.Spec.Template.Spec.ServiceAccountName = nextApp.Name + "-sa"
		ksvc.Spec.Template.Spec.ContainerConcurrency = &cc
		ksvc.Spec.Template.Spec.Containers = []corev1.Container{
			{
				Image:        nextApp.Spec.Image,
				Env:          envVars,
				EnvFrom:      envFrom,
				VolumeMounts: volumeMounts,
				Ports: []corev1.ContainerPort{
					{ContainerPort: 3000},
				},
				ReadinessProbe: &corev1.Probe{
					ProbeHandler: corev1.ProbeHandler{
						HTTPGet: &corev1.HTTPGetAction{
							Path: "/api/health",
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
		return ctrl.Result{}, err
	}

	// 4. Create/Update KafkaSource if Revalidation is enabled using Unstructured to avoid Eventing proto deps
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
			return ctrl.Result{}, err
		}
	}

	// 5. Update Status
	if ksvc.Status.URL != nil {
		nextApp.Status.URL = ksvc.Status.URL.String()
		if err := r.Status().Update(ctx, &nextApp); err != nil {
			return ctrl.Result{}, err
		}
	}

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
