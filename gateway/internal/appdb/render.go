package appdb

import (
	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// RenderConfig holds the static (non-per-app) inputs to rendering a compute — the
// Go equivalent of the constants at the top of deploy/compute-app.template.yaml.
// Defaults mirror the template so the operator renders byte-compatible objects.
type RenderConfig struct {
	Namespace      string
	PageserverHost string // PAGESERVER_HOST (default "pageserver")
	PGVersion      string // "17"
	RolePrefix     string // "app_"
	ComputeImage   string // neondatabase/compute-node-v17:8464
	InitImage      string // neondatabase/neon:8464
}

// DefaultRenderConfig fills a RenderConfig from the template's pinned values.
func DefaultRenderConfig(ns string) RenderConfig {
	return RenderConfig{
		Namespace:      ns,
		PageserverHost: "pageserver",
		PGVersion:      "17",
		RolePrefix:     "app_",
		ComputeImage:   "neondatabase/compute-node-v17:8464",
		InitImage:      "neondatabase/neon:8464",
	}
}

func labelsFor(app string) map[string]string {
	return map[string]string{"app": "compute-" + app, "tier": "apps", "plane": "compute"}
}

// managedBy marks operator-owned objects so drift-heal / cleanup can find them and
// so they are distinguishable from provision-app.sh-created ones.
func (c RenderConfig) objMeta(name, app string) metav1.ObjectMeta {
	l := labelsFor(app)
	l["app.kubernetes.io/managed-by"] = "appdb-operator"
	return metav1.ObjectMeta{Name: name, Namespace: c.Namespace, Labels: l}
}

// RenderConfigMap builds compute-config-<app> (mirrors the template ConfigMap).
func (c RenderConfig) RenderConfigMap(s ComputeSpec) *corev1.ConfigMap {
	q := s.Quotas.resolved()
	return &corev1.ConfigMap{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "ConfigMap"},
		ObjectMeta: c.objMeta("compute-config-"+s.App, s.App),
		Data: map[string]string{
			"PG_VERSION":         c.PGVersion,
			"PAGESERVER_HOST":    c.PageserverHost,
			"TENANT_ID":          s.TenantID,
			"TIMELINE_ID":        s.TimelineID,
			"APP_ROLE":           c.RolePrefix + s.App,
			"PG_MAX_CONNECTIONS": itoa(q.MaxConnections),
			"QUOTA_CPU_REQUEST":  q.CPURequest,
			"QUOTA_CPU_LIMIT":    q.CPU,
			"QUOTA_MEM_REQUEST":  q.MemRequest,
			"QUOTA_MEM_LIMIT":    q.Mem,
		},
	}
}

// RenderService builds the per-app Service (publishNotReadyAddresses like the primary).
func (c RenderConfig) RenderService(s ComputeSpec) *corev1.Service {
	return &corev1.Service{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Service"},
		ObjectMeta: c.objMeta("compute-"+s.App, s.App),
		Spec: corev1.ServiceSpec{
			PublishNotReadyAddresses: true,
			Selector:                 map[string]string{"app": "compute-" + s.App},
			Ports: []corev1.ServicePort{{
				Name: "pg", Port: 55433, TargetPort: intstr.FromString("pg"),
			}},
		},
	}
}

// RenderDeployment builds compute-<app> (mirrors the template Deployment exactly:
// wait-timeline initContainer, shared entrypoint, Recreate single-writer strategy,
// per-app quota resources, APP_ROLE_MD5 from the optional per-app Secret).
func (c RenderConfig) RenderDeployment(s ComputeSpec) *appsv1.Deployment {
	q := s.Quotas.resolved()
	replicas := int32(s.Replicas) //nolint:gosec // small bounded value
	optional := true
	histLimit := int32(2)
	grace := int64(10)
	waitScript := `set -eu
PS="http://${PAGESERVER_HOST}:9898"
until curl -sf "${PS}/v1/tenant/${TENANT_ID}/timeline" | grep -q "${TIMELINE_ID}"; do
  echo "waiting for timeline ${TIMELINE_ID} on tenant ${TENANT_ID} ..."; sleep 0.5;
done
echo "timeline ready"`

	return &appsv1.Deployment{
		TypeMeta:   metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: c.objMeta("compute-"+s.App, s.App),
		Spec: appsv1.DeploymentSpec{
			Replicas:             &replicas,
			RevisionHistoryLimit: &histLimit,
			Selector:             &metav1.LabelSelector{MatchLabels: map[string]string{"app": "compute-" + s.App}},
			Strategy:             appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labelsFor(s.App)},
				Spec: corev1.PodSpec{
					SecurityContext:               &corev1.PodSecurityContext{SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
					TerminationGracePeriodSeconds: &grace,
					InitContainers: []corev1.Container{{
						Name:    "wait-timeline",
						Image:   c.InitImage,
						EnvFrom: []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "compute-config-" + s.App}}}},
						Command: []string{"/bin/sh", "-c"},
						Args:    []string{waitScript},
					}},
					Containers: []corev1.Container{{
						Name:            "compute",
						Image:           c.ComputeImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Command:         []string{"/bin/sh", "/compute-files/entrypoint.sh"},
						EnvFrom:         []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "compute-config-" + s.App}}}},
						Env: []corev1.EnvVar{{
							Name: "APP_ROLE_MD5",
							ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
								LocalObjectReference: corev1.LocalObjectReference{Name: "app-db-" + s.App},
								Key:                  "APP_ROLE_MD5", Optional: &optional,
							}},
						}},
						Ports: []corev1.ContainerPort{
							{Name: "pg", ContainerPort: 55433},
							{Name: "compute-http", ContainerPort: 3080},
						},
						VolumeMounts: []corev1.VolumeMount{{Name: "compute-files", MountPath: "/compute-files"}},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler:        corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("pg")}},
							InitialDelaySeconds: 0, PeriodSeconds: 1, FailureThreshold: 60,
						},
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:              resource.MustParse(q.CPURequest),
								corev1.ResourceMemory:           resource.MustParse(q.MemRequest),
								corev1.ResourceEphemeralStorage: resource.MustParse("100Mi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:              resource.MustParse(q.CPU),
								corev1.ResourceMemory:           resource.MustParse(q.Mem),
								corev1.ResourceEphemeralStorage: resource.MustParse("1Gi"),
							},
						},
					}},
					Volumes: []corev1.Volume{{
						Name:         "compute-files",
						VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "compute-files"}}},
					}},
				},
			},
		},
	}
}

// roLabelsFor marks the per-app RO compute objects.
func roLabelsFor(app string) map[string]string {
	return map[string]string{"app": "compute-ro-" + app, "tier": "apps", "plane": "compute", "role": "ro"}
}

// roObjMeta is objMeta for the RO plane (compute-ro-<app>).
func (c RenderConfig) roObjMeta(name, app string) metav1.ObjectMeta {
	l := roLabelsFor(app)
	l["app.kubernetes.io/managed-by"] = "appdb-operator"
	return metav1.ObjectMeta{Name: name, Namespace: c.Namespace, Labels: l}
}

// RenderROService builds the per-app read-only Service (compute-ro-<app>). Like the
// primary RO Service it publishes not-ready addresses so the DNS record exists at 0
// replicas (the apps-gateway RO lane's TCP retry is the readiness signal, not
// CoreDNS negative-cache) and kube-proxy load-balances reads across N replicas.
func (c RenderConfig) RenderROService(s ROComputeSpec) *corev1.Service {
	return &corev1.Service{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Service"},
		ObjectMeta: c.roObjMeta("compute-ro-"+s.App, s.App),
		Spec: corev1.ServiceSpec{
			PublishNotReadyAddresses: true,
			Selector:                 map[string]string{"app": "compute-ro-" + s.App},
			Ports: []corev1.ServicePort{{
				Name: "pg", Port: 55433, TargetPort: intstr.FromString("pg"),
			}},
		},
	}
}

// RenderRODeployment builds compute-ro-<app> — the per-app read-only compute (issue
// #127). It mirrors deploy/26-compute-ro.yaml but per-app: RollingUpdate (read-only
// computes are NOT single-writer — many attach to one timeline at once, the whole
// point of a pool), RO_MODE=Replica (tip-following hot standby), entrypoint-ro.sh,
// the wait-timeline + resolve-lsn initContainers, and ephemeral storage sized for a
// LOADED replica (#121: 2Gi request / 4Gi limit — the old 1Gi evicted under
// sustained read load). It reuses the app's EXISTING per-app ConfigMap
// (compute-config-<app>) so the RO compute attaches to the app's OWN tenant+timeline
// — the isolation guarantee. Replicas 0 at rest: the apps-gateway RO lane scales it
// 0<->N on read connections (a per-app HPA, if rendered, grows N under load).
func (c RenderConfig) RenderRODeployment(s ROComputeSpec) *appsv1.Deployment {
	replicas := int32(0) // gateway RO lane scales 0<->N; HPA grows N under load
	histLimit := int32(2)
	grace := int64(10)
	maxSurge := intstr.FromInt(1)
	maxUnavail := intstr.FromInt(0)
	waitScript := `set -eu
PS="http://${PAGESERVER_HOST}:9898"
until curl -sf "${PS}/v1/tenant/${TENANT_ID}/timeline" | grep -q "${TIMELINE_ID}"; do
  echo "waiting for timeline ${TIMELINE_ID} on tenant ${TENANT_ID} ..."; sleep 0.5;
done
echo "timeline ready"`
	resolveLSNScript := `set -eu
PS="http://${PAGESERVER_HOST}:9898"
LSN="$(curl -sf "${PS}/v1/tenant/${TENANT_ID}/timeline/${TIMELINE_ID}" \
  | tr ',' '\n' | grep '"last_record_lsn"' | head -1 | cut -d'"' -f4)"
[ -n "$LSN" ] && echo "$LSN" > /ro-lsn/lsn
echo "resolved tip LSN = ${LSN:-<none>}"`
	cmRef := []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "compute-config-" + s.App}}}}

	return &appsv1.Deployment{
		TypeMeta:   metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: c.roObjMeta("compute-ro-"+s.App, s.App),
		Spec: appsv1.DeploymentSpec{
			Replicas:             &replicas,
			RevisionHistoryLimit: &histLimit,
			Selector:             &metav1.LabelSelector{MatchLabels: map[string]string{"app": "compute-ro-" + s.App}},
			// RollingUpdate (NOT Recreate): read-only computes are not single-writer.
			Strategy: appsv1.DeploymentStrategy{
				Type:          appsv1.RollingUpdateDeploymentStrategyType,
				RollingUpdate: &appsv1.RollingUpdateDeployment{MaxSurge: &maxSurge, MaxUnavailable: &maxUnavail},
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: roLabelsFor(s.App)},
				Spec: corev1.PodSpec{
					SecurityContext:               &corev1.PodSecurityContext{SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
					TerminationGracePeriodSeconds: &grace,
					InitContainers: []corev1.Container{
						{
							Name:    "wait-timeline",
							Image:   c.InitImage,
							EnvFrom: cmRef,
							Command: []string{"/bin/sh", "-c"},
							Args:    []string{waitScript},
						},
						{
							Name:         "resolve-lsn",
							Image:        c.InitImage,
							EnvFrom:      cmRef,
							Command:      []string{"/bin/sh", "-c"},
							Args:         []string{resolveLSNScript},
							VolumeMounts: []corev1.VolumeMount{{Name: "ro-lsn", MountPath: "/ro-lsn"}},
						},
					},
					Containers: []corev1.Container{{
						Name:            "compute",
						Image:           c.ComputeImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Command:         []string{"/bin/sh", "/compute-files/entrypoint-ro.sh"},
						EnvFrom:         cmRef,
						Env:             []corev1.EnvVar{{Name: "RO_MODE", Value: "Replica"}},
						Ports: []corev1.ContainerPort{
							{Name: "pg", ContainerPort: 55433},
							{Name: "compute-http", ContainerPort: 3080},
						},
						VolumeMounts: []corev1.VolumeMount{
							{Name: "compute-files", MountPath: "/compute-files"},
							{Name: "ro-lsn", MountPath: "/ro-lsn"},
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler:        corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("pg")}},
							InitialDelaySeconds: 0, PeriodSeconds: 1, FailureThreshold: 60,
						},
						Resources: corev1.ResourceRequirements{
							// ephemeral-storage sized for a LOADED read replica (#121):
							// 2Gi request (low eviction-ranking) / 4Gi limit. The old 1Gi
							// evicted compute-ro pods under sustained read load.
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:              resource.MustParse("250m"),
								corev1.ResourceMemory:           resource.MustParse("256Mi"),
								corev1.ResourceEphemeralStorage: resource.MustParse("2Gi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceMemory:           resource.MustParse("1Gi"),
								corev1.ResourceEphemeralStorage: resource.MustParse("4Gi"),
							},
						},
					}},
					Volumes: []corev1.Volume{
						{
							Name:         "compute-files",
							VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "compute-files"}}},
						},
						{Name: "ro-lsn", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
					},
				},
			},
		},
	}
}

// RenderROHPA builds an OPTIONAL per-app HorizontalPodAutoscaler for compute-ro-<app>
// (posture B in deploy/optional/27-compute-ro-hpa.yaml). Rendered only when
// MaxReplicas>0. An HPA floors the pool at minReplicas (>=1) — read replicas cost RAM
// 24/7 — so it is opt-in per app via spec.roPool.maxReplicas. minReplicas>=1 (an HPA
// cannot floor at 0). Returns nil when MaxReplicas<=0 (posture A: gateway-managed
// 0<->N, no HPA).
func (c RenderConfig) RenderROHPA(s ROComputeSpec) *autoscalingv2.HorizontalPodAutoscaler {
	if s.MaxReplicas <= 0 {
		return nil
	}
	minR := int32(1)
	if s.MinReplicas > 1 {
		minR = int32(s.MinReplicas) //nolint:gosec // small bounded value
	}
	maxR := int32(s.MaxReplicas) //nolint:gosec // small bounded value
	if maxR < minR {
		maxR = minR
	}
	util := int32(70)
	return &autoscalingv2.HorizontalPodAutoscaler{
		TypeMeta:   metav1.TypeMeta{APIVersion: "autoscaling/v2", Kind: "HorizontalPodAutoscaler"},
		ObjectMeta: c.roObjMeta("compute-ro-"+s.App, s.App),
		Spec: autoscalingv2.HorizontalPodAutoscalerSpec{
			ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{
				APIVersion: "apps/v1", Kind: "Deployment", Name: "compute-ro-" + s.App,
			},
			MinReplicas: &minR,
			MaxReplicas: maxR,
			Metrics: []autoscalingv2.MetricSpec{{
				Type: autoscalingv2.ResourceMetricSourceType,
				Resource: &autoscalingv2.ResourceMetricSource{
					Name: corev1.ResourceCPU,
					Target: autoscalingv2.MetricTarget{
						Type:               autoscalingv2.UtilizationMetricType,
						AverageUtilization: &util,
					},
				},
			}},
		},
	}
}

func itoa(n int) string {
	// small non-negative ints only (max_connections); avoid strconv import churn.
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
