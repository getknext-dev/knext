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

// SecretExists reports whether the per-app credential Secret (app-db-<app>) already
// exists. The reconciler uses this to mint the Secret exactly once — a live app's
// password is never rotated out from under it on re-provision (issue #74).
func (k *K8sCluster) SecretExists(ctx context.Context, app string) (bool, error) {
	_, err := k.cs.CoreV1().Secrets(k.ns).Get(ctx, "app-db-"+app, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

// setOwnerRef stamps owner as the sole controller ownerReference on meta, so k8s
// cascade-GC reaps the child when the AppDatabase is deleted (#122). A nil owner is
// a no-op (the CR has no UID yet) — never write an empty-UID ownerReference, which
// the GC controller would treat as dangling and delete the child.
func setOwnerRef(meta *metav1.ObjectMeta, owner *metav1.OwnerReference) {
	if owner == nil {
		return
	}
	meta.OwnerReferences = []metav1.OwnerReference{*owner}
}

// CreateSecret mints the per-app credential Secret (app-db-<app>) carrying the role,
// its plaintext password (PGPASSWORD — needed by the app's client), the non-reversible
// SCRAM-SHA-256 verifier the compute boots with (APP_ROLE_VERIFIER, issue #117), and
// the ready-to-use DATABASE_URL. An AlreadyExists is treated as success so the call is
// idempotent and NEVER overwrites a live app's password (issue #74). owner is nil-safe
// (see setOwnerRef) — a fresh Secret is stamped with the CR ownerReference for
// cascade-GC (#122) the moment the CR has a UID.
func (k *K8sCluster) CreateSecret(ctx context.Context, app, role, password, verifier, dsn string, owner *metav1.OwnerReference) error {
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app-db-" + app,
			Namespace: k.ns,
			Labels:    map[string]string{"app": "compute-" + app, "tier": "apps", "app.kubernetes.io/managed-by": "appdb-operator"},
		},
		StringData: map[string]string{
			"PGUSER":            role,
			"PGPASSWORD":        password,
			"APP_ROLE_VERIFIER": verifier, // SCRAM-SHA-256 verifier (issue #117; was APP_ROLE_MD5)
			"DATABASE_URL":      dsn,
		},
	}
	setOwnerRef(&sec.ObjectMeta, owner)
	_, err := k.cs.CoreV1().Secrets(k.ns).Create(ctx, sec, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) { // idempotent: keep the live password
		return nil
	}
	return err
}

// EnsureSecretOwnerRef back-fills the controller ownerReference on an existing
// per-app Secret (#122). Read-modify-write so it only writes when the ref is missing;
// it never touches secret data (PGPASSWORD/DATABASE_URL), so a live app is never
// disturbed. No-op when owner is nil or the secret does not exist.
func (k *K8sCluster) EnsureSecretOwnerRef(ctx context.Context, app string, owner *metav1.OwnerReference) error {
	if owner == nil {
		return nil
	}
	secApi := k.cs.CoreV1().Secrets(k.ns)
	sec, err := secApi.Get(ctx, "app-db-"+app, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil // create path mints it with the ref; nothing to back-fill yet
	}
	if err != nil {
		return err
	}
	for _, r := range sec.OwnerReferences {
		if r.UID == owner.UID && r.Kind == owner.Kind && r.APIVersion == owner.APIVersion {
			return nil // already owned — idempotent, no write
		}
	}
	setOwnerRef(&sec.ObjectMeta, owner)
	_, err = secApi.Update(ctx, sec, metav1.UpdateOptions{})
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

// DatabaseURL returns the app-db-<app> Secret's DATABASE_URL key — the writer
// DSN the warm-hold manager dials (knext #388). The hold rides the contract key
// verbatim rather than reconstructing a DSN from parts, so the hold exercises
// exactly the endpoint an external driver hands to the app. An error (missing
// Secret, missing key) means the app is not fully provisioned yet; the caller
// retries on the next pass.
func (k *K8sCluster) DatabaseURL(ctx context.Context, app string) (string, error) {
	sec, err := k.cs.CoreV1().Secrets(k.ns).Get(ctx, "app-db-"+app, metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("read app-db-%s secret: %w", app, err)
	}
	dsn := string(sec.Data["DATABASE_URL"])
	if dsn == "" {
		return "", fmt.Errorf("app-db-%s has no DATABASE_URL key yet", app)
	}
	return dsn, nil
}

// ApplyCompute upserts the ConfigMap + Deployment + Service. It PRESERVES the
// Deployment's live spec.replicas so it never fights the apps-gateway that scales
// the compute 0<->1 on connect — the operator owns the template/quotas, the gateway
// owns the replica count.
func (k *K8sCluster) ApplyCompute(ctx context.Context, spec ComputeSpec) error {
	cm := k.render.RenderConfigMap(spec)
	setOwnerRef(&cm.ObjectMeta, spec.OwnerRef)
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
		setOwnerRef(&cur.ObjectMeta, spec.OwnerRef) // back-fill on existing children
		if _, err := cmApi.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update configmap: %w", err)
		}
	}

	svc := k.render.RenderService(spec)
	setOwnerRef(&svc.ObjectMeta, spec.OwnerRef)
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
		setOwnerRef(&cur.ObjectMeta, spec.OwnerRef)
		if _, err := svcApi.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update service: %w", err)
		}
	}

	dep := k.render.RenderDeployment(spec)
	setOwnerRef(&dep.ObjectMeta, spec.OwnerRef)
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
		setOwnerRef(&cur.ObjectMeta, spec.OwnerRef)
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
	setOwnerRef(&svc.ObjectMeta, spec.OwnerRef)
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
		setOwnerRef(&cur.ObjectMeta, spec.OwnerRef)
		if _, err := svcApi.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update ro service: %w", err)
		}
	}

	dep := k.render.RenderRODeployment(spec)
	setOwnerRef(&dep.ObjectMeta, spec.OwnerRef)
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
		setOwnerRef(&cur.ObjectMeta, spec.OwnerRef)
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
	setOwnerRef(&hpa.ObjectMeta, spec.OwnerRef)
	if cur, err := hpaApi.Get(ctx, hpa.Name, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if _, err := hpaApi.Create(ctx, hpa, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create ro hpa: %w", err)
		}
	} else if err != nil {
		return err
	} else {
		cur.Spec = hpa.Spec
		cur.Labels = hpa.Labels
		setOwnerRef(&cur.ObjectMeta, spec.OwnerRef)
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

// DeleteCompute removes the writer compute's child objects — Deployment, Service,
// ConfigMap, then Secret — during deprovision. Every delete is ignore-not-found so the
// call is idempotent and survives partial prior runs (a crash mid-delete simply re-runs
// clean). It is belt-and-suspenders over ownerReference cascade-GC (#122): the finalizer
// path (reconcileDelete) calls this explicitly so deprovision does not depend on the GC
// controller having run. The Deployment goes first so no pod is left attached to the
// timeline before the two-sided WAL reclaim.
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

// DeploymentAvailable reports whether compute-<app> has at least one available
// replica. It is the readiness signal the reconciler folds into status (Ready vs
// Provisioning for the warm tier). A missing Deployment is not an error — it reads as
// "not available" so a mid-provision pass settles gracefully.
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

// RecordReclaimPending durably notes a timeline whose two-sided WAL reclaim could not
// finish (one or more safekeepers down), keyed by timeline id in the shared reclaim
// ledger ConfigMap (apps-wal-reclaim-pending, shared with provision-app.sh). This is
// what stops a failed deprovision from silently leaking WAL (issue #91): the ledger
// entry survives the operator, so reconcileDelete keeps the finalizer + requeues until
// the reclaim completes, and provision-app.sh reclaim-orphans is the independent
// backstop. Creates the ledger ConfigMap on first use; the merge-patch upserts the key.
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

// ClearReclaimPending drops a timeline's entry from the reclaim ledger once the WAL is
// fully reclaimed (all safekeepers + pageserver acked the delete). No-op when the ledger
// or the key is absent (idempotent). Uses a JSON-patch remove (vs the merge-patch upsert
// in RecordReclaimPending) to delete exactly one key without rewriting the whole map.
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

// AddFinalizer adds the deprovision finalizer to the CR so its deletion blocks until
// the operator has run safe deprovision (WAL reclaim + child teardown). Reconcile calls
// this FIRST, before any external resource exists (issue #91).
func (k *K8sCluster) AddFinalizer(ctx context.Context, cr *AppDatabase) error {
	return k.patchFinalizers(ctx, cr, true)
}

// RemoveFinalizer drops the deprovision finalizer once reclaim is complete, unblocking
// the API server to actually delete the CR object.
func (k *K8sCluster) RemoveFinalizer(ctx context.Context, cr *AppDatabase) error {
	return k.patchFinalizers(ctx, cr, false)
}

// patchFinalizers is the read-modify-write core behind Add/RemoveFinalizer. It fetches
// the live object (dynamic client, so it works on the CR's metadata), toggles the single
// deprovision finalizer, and writes back — then syncs the CR's in-memory Finalizers and
// ResourceVersion so the caller's optimistic-concurrency view stays current. A missing
// object is a no-op (already deleted).
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

// toMap round-trips a typed value through JSON into a map[string]any — the shape the
// dynamic client's unstructured status subresource expects (used by UpdateStatus).
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
