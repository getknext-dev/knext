package zone

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
)

// DynAppDB implements AppDBOps against the AppDatabase CRD via the dynamic client
// (ADR-0006 compose). The Zone operator OWNS the AppDatabase it creates (an
// ownerReference back to the Zone) so a Zone delete garbage-collects the AppDatabase
// even outside the finalizer path; the finalizer path additionally WAITS for the
// AppDatabase's own two-sided timeline reclaim before releasing the Zone.
type DynAppDB struct {
	dyn dynamic.Interface
	ns  string
}

// NewDynAppDB wires a DynAppDB.
func NewDynAppDB(dyn dynamic.Interface, ns string) *DynAppDB { return &DynAppDB{dyn: dyn, ns: ns} }

func (a *DynAppDB) res() dynamic.ResourceInterface {
	return a.dyn.Resource(AppDBGVR).Namespace(a.ns)
}

// EnsureAppDatabase creates-or-updates the composed AppDatabase. It writes ONLY the
// spec (and ownerReferences on create) — the appdb operator owns status. Idempotent:
// on update it patches the spec fields the Zone delegates and leaves the rest.
func (a *DynAppDB) EnsureAppDatabase(ctx context.Context, s ComposeSpec) error {
	q := s.Quotas
	if q.CPU == "" {
		q.CPU = DefaultQuotas.CPU
	}
	if q.CPURequest == "" {
		q.CPURequest = DefaultQuotas.CPURequest
	}
	if q.Mem == "" {
		q.Mem = DefaultQuotas.Mem
	}
	if q.MemRequest == "" {
		q.MemRequest = DefaultQuotas.MemRequest
	}
	if q.MaxConnections == 0 {
		q.MaxConnections = DefaultQuotas.MaxConnections
	}
	spec := map[string]any{
		"appName": s.Zone,
		"tier":    s.Tier,
		"quotas": map[string]any{
			"cpu":            q.CPU,
			"cpuRequest":     q.CPURequest,
			"mem":            q.Mem,
			"memRequest":     q.MemRequest,
			"maxConnections": int64(q.MaxConnections),
		},
		"roPool": map[string]any{"enabled": s.ReadReplicas},
	}

	cur, err := a.res().Get(ctx, s.Zone, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		obj := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": AppDBGVR.Group + "/" + AppDBGVR.Version,
			"kind":       "AppDatabase",
			"metadata": map[string]any{
				"name":      s.Zone,
				"namespace": a.ns,
				"labels":    map[string]any{"app.kubernetes.io/managed-by": "zone-operator", "zone": s.Zone},
				"ownerReferences": []any{map[string]any{
					"apiVersion":         Group + "/" + Version,
					"kind":               Kind,
					"name":               s.OwnerName,
					"uid":                s.OwnerUID,
					"controller":         true,
					"blockOwnerDeletion": true,
				}},
			},
			"spec": spec,
		}}
		_, err = a.res().Create(ctx, obj, metav1.CreateOptions{})
		if apierrors.IsAlreadyExists(err) {
			return nil
		}
		return err
	}
	if err != nil {
		return err
	}
	// Update the delegated spec fields; preserve everything else.
	if err := unstructured.SetNestedMap(cur.Object, spec, "spec"); err != nil {
		return err
	}
	_, err = a.res().Update(ctx, cur, metav1.UpdateOptions{})
	if apierrors.IsConflict(err) {
		return nil // next resync retries
	}
	return err
}

// AppDatabaseReady reports whether status.phase == Ready.
func (a *DynAppDB) AppDatabaseReady(ctx context.Context, name string) (bool, error) {
	obj, err := a.res().Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
	return phase == "Ready", nil
}

// DeleteAppDatabase deletes the composed AppDatabase and reports gone=true once the
// object is actually removed (so the Zone finalizer waits for the timeline reclaim).
func (a *DynAppDB) DeleteAppDatabase(ctx context.Context, name string) (bool, error) {
	err := a.res().Delete(ctx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	// Confirm it is gone (its own finalizer may still be reclaiming the timeline).
	_, gerr := a.res().Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(gerr) {
		return true, nil
	}
	if gerr != nil {
		return false, fmt.Errorf("confirm appdatabase deleted: %w", gerr)
	}
	return false, nil
}

var _ AppDBOps = (*DynAppDB)(nil)
