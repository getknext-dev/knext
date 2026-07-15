package appdb

import (
	"context"
	"encoding/json"
	"log"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
)

// Controller drives continuous reconciliation. It reconciles EVERY AppDatabase on a
// resync tick and immediately on any watch event — a lean client-go loop (no
// controller-runtime, consistent with cmd/pswatcher). Because each pass re-derives
// desired state from the CR + observed reality, the loop is crash-safe and
// drift-healing by construction, and "requeue" is just the next resync (no bespoke
// workqueue needed at the tens/low-hundreds-of-apps scale bound, ADR-0004).
type Controller struct {
	dyn    dynamic.Interface
	deps   *Deps
	ns     string
	resync time.Duration
	log    *log.Logger

	// health reporting
	lastSync   time.Time
	lastErr    error
	reconciles int64
}

// NewController wires a Controller. resync is the periodic full-reconcile backstop.
func NewController(dyn dynamic.Interface, deps *Deps, ns string, resync time.Duration, logger *log.Logger) *Controller {
	return &Controller{dyn: dyn, deps: deps, ns: ns, resync: resync, log: logger}
}

// Run blocks until ctx is cancelled, reconciling on resync ticks and watch events.
func (c *Controller) Run(ctx context.Context) error {
	trigger := make(chan struct{}, 1)
	go c.watch(ctx, trigger)

	ticker := time.NewTicker(c.resync)
	defer ticker.Stop()

	c.reconcileAll(ctx) // initial sync
	for {
		select {
		case <-ctx.Done():
			c.log.Print("[appdb] shutting down")
			return nil
		case <-ticker.C:
			c.reconcileAll(ctx)
		case <-trigger:
			// small debounce so a burst of watch events coalesces into one pass
			time.Sleep(200 * time.Millisecond)
			drain(trigger)
			c.reconcileAll(ctx)
		}
	}
}

// watch feeds the trigger channel on any AppDatabase change; it self-restarts if the
// watch drops (the resync ticker is the backstop meanwhile).
func (c *Controller) watch(ctx context.Context, trigger chan<- struct{}) {
	for ctx.Err() == nil {
		w, err := c.dyn.Resource(GVR).Namespace(c.ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			c.log.Printf("[appdb] watch error (will retry, resync covers the gap): %v", err)
			time.Sleep(2 * time.Second)
			continue
		}
		for range w.ResultChan() {
			select {
			case trigger <- struct{}{}:
			default:
			}
		}
		w.Stop()
	}
}

// reconcileAll reconciles every AppDatabase once. A per-CR error is logged and does
// not stop the others — the next resync retries.
func (c *Controller) reconcileAll(ctx context.Context) {
	list, err := c.dyn.Resource(GVR).Namespace(c.ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		c.lastErr = err
		c.log.Printf("[appdb] list AppDatabases: %v", err)
		return
	}
	for i := range list.Items {
		cr, cerr := fromUnstructured(&list.Items[i])
		if cerr != nil {
			c.log.Printf("[appdb] decode %s: %v", list.Items[i].GetName(), cerr)
			continue
		}
		requeue, rerr := c.deps.Reconcile(ctx, cr)
		c.reconciles++
		if rerr != nil {
			c.lastErr = rerr
			c.log.Printf("[appdb] reconcile %s: %v", cr.Name, rerr)
			continue
		}
		if requeue {
			c.log.Printf("[appdb] %s reconciled (requeued for next resync)", cr.Name)
		}
	}
	c.lastSync = c.deps.Now().Time
	c.lastErr = nil
}

// Healthy reports whether the controller has completed a recent successful sync.
func (c *Controller) Healthy() bool {
	if c.lastSync.IsZero() {
		return true // starting up; give the initial sync a chance
	}
	return c.deps.Now().Time.Sub(c.lastSync) < 3*c.resync
}

func drain(ch <-chan struct{}) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// fromUnstructured converts a CR into the typed struct the reconciler operates on.
func fromUnstructured(u *unstructured.Unstructured) (*AppDatabase, error) {
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
		Spec   AppDatabaseSpec   `json:"spec"`
		Status AppDatabaseStatus `json:"status"`
	}
	b, err := json.Marshal(u.Object)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	return &AppDatabase{
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
