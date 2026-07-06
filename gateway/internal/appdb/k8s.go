package appdb

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

// K8sCluster implements ClusterOps against a real cluster: the typed clientset for
// the per-app child objects (Secret/ConfigMap/Deployment/Service) and the reclaim
// ledger, and the dynamic client for the AppDatabase CR's status/finalizer.
type K8sCluster struct {
	cs        kubernetes.Interface
	dyn       dynamic.Interface
	ns        string
	render    RenderConfig
	reclaimCM string
	log       *log.Logger
}

// NewK8sCluster wires a K8sCluster. reclaimCM is the durable ledger name (shared
// with provision-app.sh, default apps-wal-reclaim-pending).
func NewK8sCluster(cs kubernetes.Interface, dyn dynamic.Interface, ns string, render RenderConfig, reclaimCM string, logger *log.Logger) *K8sCluster {
	return &K8sCluster{cs: cs, dyn: dyn, ns: ns, render: render, reclaimCM: reclaimCM, log: logger}
}

func (k *K8sCluster) SecretExists(ctx context.Context, app string) (bool, error) {
	_, err := k.cs.CoreV1().Secrets(k.ns).Get(ctx, "app-db-"+app, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

func (k *K8sCluster) CreateSecret(ctx context.Context, app, role, password, md5, dsn string) error {
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app-db-" + app,
			Namespace: k.ns,
			Labels:    map[string]string{"app": "compute-" + app, "tier": "apps", "app.kubernetes.io/managed-by": "appdb-operator"},
		},
		StringData: map[string]string{
			"PGUSER":       role,
			"PGPASSWORD":   password,
			"APP_ROLE_MD5": md5,
			"DATABASE_URL": dsn,
		},
	}
	_, err := k.cs.CoreV1().Secrets(k.ns).Create(ctx, sec, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) { // idempotent: keep the live password
		return nil
	}
	return err
}

// EnsureSecretROKey reconciles the DATABASE_URL_RO key on app-db-<app> to match
// the read-replica-pool request (ADR-0006 #119). When enabled it derives the RO
// DSN from the live DATABASE_URL (swap the gateway port) and sets the key; when
// disabled it removes the key. It patches ONLY that one key — PGPASSWORD and the
// writer DATABASE_URL are never touched, so a live app is never locked out. No-op
// (no API write) when the secret is absent or already in the desired state.
func (k *K8sCluster) EnsureSecretROKey(ctx context.Context, app string, enabled bool, writerPort, roPort int) error {
	secApi := k.cs.CoreV1().Secrets(k.ns)
	sec, err := secApi.Get(ctx, "app-db-"+app, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil // no secret yet; the create path mints it, next pass reconciles the RO key
	}
	if err != nil {
		return err
	}

	cur := string(sec.Data["DATABASE_URL_RO"]) // "" if the key is absent
	want := ""
	if enabled {
		writer := string(sec.Data["DATABASE_URL"])
		if writer == "" {
			return fmt.Errorf("app-db-%s has no DATABASE_URL to derive DATABASE_URL_RO from", app)
		}
		want = roDSN(writer, writerPort, roPort)
	}
	if cur == want {
		return nil // already in the desired state — idempotent, no write
	}

	var patch []byte
	if want == "" {
		// merge-patch null removes just the DATABASE_URL_RO key.
		patch = []byte(`{"data":{"DATABASE_URL_RO":null}}`)
	} else {
		enc := base64.StdEncoding.EncodeToString([]byte(want))
		patch = []byte(fmt.Sprintf(`{"data":{"DATABASE_URL_RO":%q}}`, enc))
	}
	_, err = secApi.Patch(ctx, "app-db-"+app, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

// ApplyCompute upserts the ConfigMap + Deployment + Service. It PRESERVES the
// Deployment's live spec.replicas so it never fights the apps-gateway that scales
// the compute 0<->1 on connect — the operator owns the template/quotas, the gateway
// owns the replica count.
func (k *K8sCluster) ApplyCompute(ctx context.Context, spec ComputeSpec) error {
	cm := k.render.RenderConfigMap(spec)
	cmApi := k.cs.CoreV1().ConfigMaps(k.ns)
	if cur, err := cmApi.Get(ctx, cm.Name, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if _, err := cmApi.Create(ctx, cm, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create configmap: %w", err)
		}
	} else if err != nil {
		return err
	} else {
		cur.Data = cm.Data
		cur.Labels = cm.Labels
		if _, err := cmApi.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update configmap: %w", err)
		}
	}

	svc := k.render.RenderService(spec)
	svcApi := k.cs.CoreV1().Services(k.ns)
	if cur, err := svcApi.Get(ctx, svc.Name, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if _, err := svcApi.Create(ctx, svc, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create service: %w", err)
		}
	} else if err != nil {
		return err
	} else {
		// Preserve immutable/allocated fields; update only what we own.
		cur.Spec.Selector = svc.Spec.Selector
		cur.Spec.Ports = svc.Spec.Ports
		cur.Spec.PublishNotReadyAddresses = svc.Spec.PublishNotReadyAddresses
		cur.Labels = svc.Labels
		if _, err := svcApi.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update service: %w", err)
		}
	}

	dep := k.render.RenderDeployment(spec)
	depApi := k.cs.AppsV1().Deployments(k.ns)
	if cur, err := depApi.Get(ctx, dep.Name, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if _, err := depApi.Create(ctx, dep, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create deployment: %w", err)
		}
	} else if err != nil {
		return err
	} else {
		// Heal template/quota drift but PRESERVE the gateway-owned replica count.
		liveReplicas := cur.Spec.Replicas
		cur.Spec = dep.Spec
		cur.Spec.Replicas = liveReplicas
		cur.Labels = dep.Labels
		if _, err := depApi.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update deployment: %w", err)
		}
	}
	return nil
}

// ApplyROCompute upserts the per-app read-only compute (compute-ro-<app> Deployment
// + Service, and — when MaxReplicas>0 — a per-app HPA), attached to the app's OWN
// timeline via the shared compute-config-<app> ConfigMap (issue #127). Like
// ApplyCompute it PRESERVES the Deployment's live spec.replicas so it never fights
// the apps-gateway RO lane that scales the pool 0<->N on read connections.
func (k *K8sCluster) ApplyROCompute(ctx context.Context, spec ROComputeSpec) error {
	svc := k.render.RenderROService(spec)
	svcApi := k.cs.CoreV1().Services(k.ns)
	if cur, err := svcApi.Get(ctx, svc.Name, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if _, err := svcApi.Create(ctx, svc, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create ro service: %w", err)
		}
	} else if err != nil {
		return err
	} else {
		cur.Spec.Selector = svc.Spec.Selector
		cur.Spec.Ports = svc.Spec.Ports
		cur.Spec.PublishNotReadyAddresses = svc.Spec.PublishNotReadyAddresses
		cur.Labels = svc.Labels
		if _, err := svcApi.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update ro service: %w", err)
		}
	}

	dep := k.render.RenderRODeployment(spec)
	depApi := k.cs.AppsV1().Deployments(k.ns)
	if cur, err := depApi.Get(ctx, dep.Name, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if _, err := depApi.Create(ctx, dep, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create ro deployment: %w", err)
		}
	} else if err != nil {
		return err
	} else {
		// Heal template drift but PRESERVE the gateway-owned replica count.
		liveReplicas := cur.Spec.Replicas
		cur.Spec = dep.Spec
		cur.Spec.Replicas = liveReplicas
		cur.Labels = dep.Labels
		if _, err := depApi.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update ro deployment: %w", err)
		}
	}

	// Optional per-app HPA (posture B). Rendered only when MaxReplicas>0; otherwise
	// ensure any stale HPA is removed so the pool reverts to gateway-managed 0<->N.
	hpaApi := k.cs.AutoscalingV2().HorizontalPodAutoscalers(k.ns)
	hpa := k.render.RenderROHPA(spec)
	if hpa == nil {
		if err := k.cs.AutoscalingV2().HorizontalPodAutoscalers(k.ns).Delete(ctx, "compute-ro-"+spec.App, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("remove ro hpa: %w", err)
		}
		return nil
	}
	if cur, err := hpaApi.Get(ctx, hpa.Name, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if _, err := hpaApi.Create(ctx, hpa, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create ro hpa: %w", err)
		}
	} else if err != nil {
		return err
	} else {
		cur.Spec = hpa.Spec
		cur.Labels = hpa.Labels
		if _, err := hpaApi.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update ro hpa: %w", err)
		}
	}
	return nil
}

// DeleteROCompute removes the app's read-only compute (Deployment + Service + HPA),
// ignore-not-found. Called when roPool is disabled or the app is deprovisioned.
func (k *K8sCluster) DeleteROCompute(ctx context.Context, app string) error {
	del := metav1.DeleteOptions{}
	ign := func(err error) error {
		if err == nil || apierrors.IsNotFound(err) {
			return nil
		}
		return err
	}
	if err := ign(k.cs.AutoscalingV2().HorizontalPodAutoscalers(k.ns).Delete(ctx, "compute-ro-"+app, del)); err != nil {
		return err
	}
	if err := ign(k.cs.AppsV1().Deployments(k.ns).Delete(ctx, "compute-ro-"+app, del)); err != nil {
		return err
	}
	if err := ign(k.cs.CoreV1().Services(k.ns).Delete(ctx, "compute-ro-"+app, del)); err != nil {
		return err
	}
	return nil
}

func (k *K8sCluster) DeleteCompute(ctx context.Context, app string) error {
	del := metav1.DeleteOptions{}
	ign := func(err error) error {
		if err == nil || apierrors.IsNotFound(err) {
			return nil
		}
		return err
	}
	if err := ign(k.cs.AppsV1().Deployments(k.ns).Delete(ctx, "compute-"+app, del)); err != nil {
		return err
	}
	if err := ign(k.cs.CoreV1().Services(k.ns).Delete(ctx, "compute-"+app, del)); err != nil {
		return err
	}
	if err := ign(k.cs.CoreV1().ConfigMaps(k.ns).Delete(ctx, "compute-config-"+app, del)); err != nil {
		return err
	}
	if err := ign(k.cs.CoreV1().Secrets(k.ns).Delete(ctx, "app-db-"+app, del)); err != nil {
		return err
	}
	return nil
}

func (k *K8sCluster) DeploymentAvailable(ctx context.Context, app string) (bool, error) {
	dep, err := k.cs.AppsV1().Deployments(k.ns).Get(ctx, "compute-"+app, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return dep.Status.AvailableReplicas >= 1, nil
}

func (k *K8sCluster) RecordReclaimPending(ctx context.Context, tl, ordinals string) error {
	cmApi := k.cs.CoreV1().ConfigMaps(k.ns)
	if _, err := cmApi.Get(ctx, k.reclaimCM, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{
			Name: k.reclaimCM, Namespace: k.ns,
			Labels: map[string]string{"tier": "apps", "app": "wal-reclaim"},
		}}
		if _, err := cmApi.Create(ctx, cm, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
			return err
		}
	}
	patch := []byte(fmt.Sprintf(`{"data":{%q:"safekeepers=%s recorded=by-operator"}}`, tl, ordinals))
	_, err := cmApi.Patch(ctx, k.reclaimCM, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

func (k *K8sCluster) ClearReclaimPending(ctx context.Context, tl string) error {
	cmApi := k.cs.CoreV1().ConfigMaps(k.ns)
	cm, err := cmApi.Get(ctx, k.reclaimCM, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, ok := cm.Data[tl]; !ok {
		return nil
	}
	patch := []byte(fmt.Sprintf(`[{"op":"remove","path":"/data/%s"}]`, tl))
	_, err = cmApi.Patch(ctx, k.reclaimCM, types.JSONPatchType, patch, metav1.PatchOptions{})
	return err
}

// UpdateStatus persists cr.Status via the status subresource (read-modify-write to
// carry the live resourceVersion).
func (k *K8sCluster) UpdateStatus(ctx context.Context, cr *AppDatabase) error {
	res := k.dyn.Resource(GVR).Namespace(cr.Namespace)
	obj, err := res.Get(ctx, cr.Name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil // object gone (mid-delete) — nothing to update
		}
		return err
	}
	statusMap, err := toMap(cr.Status)
	if err != nil {
		return err
	}
	obj.Object["status"] = statusMap
	if _, err := res.UpdateStatus(ctx, obj, metav1.UpdateOptions{}); err != nil {
		if apierrors.IsNotFound(err) || apierrors.IsConflict(err) {
			return nil // benign: object gone or will be re-reconciled next pass
		}
		return err
	}
	return nil
}

func (k *K8sCluster) AddFinalizer(ctx context.Context, cr *AppDatabase) error {
	return k.patchFinalizers(ctx, cr, true)
}
func (k *K8sCluster) RemoveFinalizer(ctx context.Context, cr *AppDatabase) error {
	return k.patchFinalizers(ctx, cr, false)
}

func (k *K8sCluster) patchFinalizers(ctx context.Context, cr *AppDatabase, add bool) error {
	res := k.dyn.Resource(GVR).Namespace(cr.Namespace)
	obj, err := res.Get(ctx, cr.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	fins := obj.GetFinalizers()
	has := false
	out := fins[:0:0]
	for _, f := range fins {
		if f == Finalizer {
			has = true
			if !add {
				continue // drop it
			}
		}
		out = append(out, f)
	}
	if add && !has {
		out = append(out, Finalizer)
	}
	obj.SetFinalizers(out)
	updated, err := res.Update(ctx, obj, metav1.UpdateOptions{})
	if err != nil {
		return err
	}
	cr.Finalizers = updated.GetFinalizers()
	cr.ResourceVersion = updated.GetResourceVersion()
	return nil
}

// Event logs and best-effort records a Kubernetes Event on the CR.
func (k *K8sCluster) Event(cr *AppDatabase, eventType, reason, message string) {
	if k.log != nil {
		k.log.Printf("[appdb] %s/%s %s %s: %s", cr.Namespace, cr.Name, eventType, reason, message)
	}
	now := metav1.Now()
	ev := &corev1.Event{
		ObjectMeta: metav1.ObjectMeta{GenerateName: cr.Name + ".", Namespace: cr.Namespace},
		InvolvedObject: corev1.ObjectReference{
			Kind: Kind, Namespace: cr.Namespace, Name: cr.Name,
			UID: types.UID(cr.UID), APIVersion: Group + "/" + Version,
		},
		Reason: reason, Message: message, Type: eventType,
		Source:         corev1.EventSource{Component: "appdb-operator"},
		FirstTimestamp: now, LastTimestamp: now, Count: 1,
	}
	_, _ = k.cs.CoreV1().Events(cr.Namespace).Create(context.Background(), ev, metav1.CreateOptions{})
}

func toMap(v any) (map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// compile-time assertion.
var _ ClusterOps = (*K8sCluster)(nil)
var _ PageserverOps = (*HTTPPageserver)(nil)
var _ SafekeeperOps = (*HTTPSafekeeper)(nil)
