package zone

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

// K8sCluster implements ClusterOps + ZoneLister against a real cluster: the typed
// clientset for the per-zone repl Secret + compute wake control, and the dynamic
// client for the Zone CR's status/finalizer.
type K8sCluster struct {
	cs        kubernetes.Interface
	dyn       dynamic.Interface
	ns        string
	wakeTOsec int
	log       *log.Logger
}

// NewK8sCluster wires a K8sCluster. wakeTimeout bounds how long WakeCompute waits.
func NewK8sCluster(cs kubernetes.Interface, dyn dynamic.Interface, ns string, wakeTimeoutSec int, logger *log.Logger) *K8sCluster {
	return &K8sCluster{cs: cs, dyn: dyn, ns: ns, wakeTOsec: wakeTimeoutSec, log: logger}
}

// replSecretName is the per-zone repl-credential Secret (holds REPL_ROLE /
// REPL_PASSWORD / REPL_ROLE_MD5). Deterministic so a consumer can read a peer's
// credential by zone name to build its subscription conninfo.
func replSecretName(zone string) string { return "zone-repl-" + zone }

// EnsureReplSecret mints zone-repl-<zone> if absent (preserving a live password on
// re-reconcile so a running subscription is never invalidated), and returns the
// current password + md5(password||role).
func (k *K8sCluster) EnsureReplSecret(ctx context.Context, zone, role string, newPassword func() string) (string, string, error) {
	name := replSecretName(zone)
	secApi := k.cs.CoreV1().Secrets(k.ns)
	sec, err := secApi.Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		pw := string(sec.Data["REPL_PASSWORD"])
		if pw == "" {
			return "", "", fmt.Errorf("%s missing REPL_PASSWORD", name)
		}
		return pw, zoneMD5(pw, role), nil
	}
	if !apierrors.IsNotFound(err) {
		return "", "", err
	}
	pw := newPassword()
	md5hex := zoneMD5(pw, role)
	obj := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: k.ns,
			Labels: map[string]string{"zone": zone, "tier": "apps", "app.kubernetes.io/managed-by": "zone-operator"},
		},
		StringData: map[string]string{"REPL_ROLE": role, "REPL_PASSWORD": pw, "REPL_ROLE_MD5": md5hex},
	}
	if _, err := secApi.Create(ctx, obj, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
		return "", "", err
	}
	return pw, md5hex, nil
}

// ReplSecret reads a (possibly peer) zone's repl Secret.
func (k *K8sCluster) ReplSecret(ctx context.Context, zone string) (string, string, bool, error) {
	sec, err := k.cs.CoreV1().Secrets(k.ns).Get(ctx, replSecretName(zone), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return string(sec.Data["REPL_PASSWORD"]), string(sec.Data["REPL_ROLE_MD5"]), true, nil
}

// DeleteReplSecret removes zone-repl-<zone> (deprovision). Idempotent.
func (k *K8sCluster) DeleteReplSecret(ctx context.Context, zone string) error {
	err := k.cs.CoreV1().Secrets(k.ns).Delete(ctx, replSecretName(zone), metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// ComputeExists reports whether the compute-<zone> Deployment exists.
func (k *K8sCluster) ComputeExists(ctx context.Context, zone string) (bool, error) {
	_, err := k.cs.AppsV1().Deployments(k.ns).Get(ctx, "compute-"+zone, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

// ComputeAwake reports whether compute-<zone> has >=1 available replica.
func (k *K8sCluster) ComputeAwake(ctx context.Context, zone string) (bool, error) {
	dep, err := k.cs.AppsV1().Deployments(k.ns).Get(ctx, "compute-"+zone, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return dep.Status.AvailableReplicas >= 1, nil
}

// WakeCompute scales compute-<zone> to 1 (if not already >=1) and waits until a
// replica is available, so admin SQL can run. The apps-gateway owns 0<->1 in steady
// state; the operator only nudges it up to apply SQL (a short window), and the
// gateway's idle timer returns it to 0 afterward. Returns an error if the Deployment
// is absent (the composed AppDatabase has not created it yet) or the wait times out.
func (k *K8sCluster) WakeCompute(ctx context.Context, zone string) error {
	depApi := k.cs.AppsV1().Deployments(k.ns)
	dep, err := depApi.Get(ctx, "compute-"+zone, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return fmt.Errorf("compute-%s deployment not found", zone)
	}
	if err != nil {
		return err
	}
	if dep.Status.AvailableReplicas >= 1 {
		return nil
	}
	if dep.Spec.Replicas == nil || *dep.Spec.Replicas < 1 {
		one := int32(1)
		patch := []byte(fmt.Sprintf(`{"spec":{"replicas":%d}}`, one))
		if _, err := depApi.Patch(ctx, "compute-"+zone, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
			return fmt.Errorf("scale compute-%s up: %w", zone, err)
		}
	}
	deadline := time.Now().Add(time.Duration(k.wakeTOsec) * time.Second)
	for time.Now().Before(deadline) {
		d, err := depApi.Get(ctx, "compute-"+zone, metav1.GetOptions{})
		if err == nil && d.Status.AvailableReplicas >= 1 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("timed out waiting for compute-%s to wake", zone)
}

// UpdateStatus persists cr.Status via the status subresource.
func (k *K8sCluster) UpdateStatus(ctx context.Context, cr *Zone) error {
	res := k.dyn.Resource(GVR).Namespace(cr.Namespace)
	obj, err := res.Get(ctx, cr.Name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil
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
			return nil
		}
		return err
	}
	return nil
}

// AddFinalizer ensures the deprovision finalizer is present so a Zone delete always
// runs cross-zone hygiene (ADR-0007 §4d) before the object is removed.
func (k *K8sCluster) AddFinalizer(ctx context.Context, cr *Zone) error {
	return k.patchFinalizers(ctx, cr, true)
}

// RemoveFinalizer strips the deprovision finalizer — the LAST step of reconcileDelete,
// letting the API server actually delete the Zone once all peer-side cleanup is done.
func (k *K8sCluster) RemoveFinalizer(ctx context.Context, cr *Zone) error {
	return k.patchFinalizers(ctx, cr, false)
}

// patchFinalizers adds or removes Finalizer via a read-modify-write Update, then
// syncs the live finalizer list + resourceVersion back onto cr so a following
// UpdateStatus in the same pass doesn't conflict. Ignore-not-found: a Zone deleted
// out from under us is a no-op.
func (k *K8sCluster) patchFinalizers(ctx context.Context, cr *Zone, add bool) error {
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
				continue
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

// Event logs and best-effort records a Kubernetes Event on the Zone CR.
func (k *K8sCluster) Event(cr *Zone, eventType, reason, message string) {
	if k.log != nil {
		k.log.Printf("[zone] %s/%s %s %s: %s", cr.Namespace, cr.Name, eventType, reason, message)
	}
	now := metav1.Now()
	ev := &corev1.Event{
		ObjectMeta: metav1.ObjectMeta{GenerateName: cr.Name + ".", Namespace: cr.Namespace},
		InvolvedObject: corev1.ObjectReference{
			Kind: Kind, Namespace: cr.Namespace, Name: cr.Name,
			UID: types.UID(cr.UID), APIVersion: Group + "/" + Version,
		},
		Reason: reason, Message: message, Type: eventType,
		Source:         corev1.EventSource{Component: "zone-operator"},
		FirstTimestamp: now, LastTimestamp: now, Count: 1,
	}
	_, _ = k.cs.CoreV1().Events(cr.Namespace).Create(context.Background(), ev, metav1.CreateOptions{})
}

// ListZones lists every Zone CR in the namespace (ZoneLister — for the governance guards).
func (k *K8sCluster) ListZones(ctx context.Context) ([]*Zone, error) {
	list, err := k.dyn.Resource(GVR).Namespace(k.ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]*Zone, 0, len(list.Items))
	for i := range list.Items {
		z, err := FromUnstructured(&list.Items[i])
		if err != nil {
			if k.log != nil {
				k.log.Printf("[zone] decode %s: %v", list.Items[i].GetName(), err)
			}
			continue
		}
		out = append(out, z)
	}
	return out, nil
}

// FromUnstructured converts a Zone CR into the typed struct the reconciler operates on.
func FromUnstructured(u *unstructured.Unstructured) (*Zone, error) {
	var raw struct {
		Metadata struct {
			Name              string       `json:"name"`
			Namespace         string       `json:"namespace"`
			UID               string       `json:"uid"`
			ResourceVersion   string       `json:"resourceVersion"`
			Generation        int64        `json:"generation"`
			DeletionTimestamp *metav1.Time `json:"deletionTimestamp"`
			Finalizers        []string     `json:"finalizers"`
		} `json:"metadata"`
		Spec   ZoneSpec   `json:"spec"`
		Status ZoneStatus `json:"status"`
	}
	b, err := json.Marshal(u.Object)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	return &Zone{
		Name:              raw.Metadata.Name,
		Namespace:         raw.Metadata.Namespace,
		UID:               raw.Metadata.UID,
		ResourceVersion:   raw.Metadata.ResourceVersion,
		Generation:        raw.Metadata.Generation,
		DeletionTimestamp: raw.Metadata.DeletionTimestamp,
		Finalizers:        raw.Metadata.Finalizers,
		Spec:              raw.Spec,
		Status:            raw.Status,
	}, nil
}

// toMap round-trips a value through JSON into a map[string]any — the shape the
// dynamic client's unstructured status subresource requires.
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

var (
	_ ClusterOps = (*K8sCluster)(nil)
	_ ZoneLister = (*K8sCluster)(nil)
)
