package zone

import (
	"context"
	"log"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
)

// Controller drives continuous reconciliation of every Zone on a resync tick and on
// any watch event — the same lean client-go loop as the appdb operator. Each pass
// re-derives desired state from the CR + observed reality, so the loop is crash-safe
// and drift-healing, and "requeue" is just the next resync.
type Controller struct {
	dyn    dynamic.Interface
	deps   *Deps
	ns     string
	resync time.Duration
	log    *log.Logger

	lastSync   time.Time
	lastErr    error
	reconciles int64
}

// NewController wires a Controller.
func NewController(dyn dynamic.Interface, deps *Deps, ns string, resync time.Duration, logger *log.Logger) *Controller {
	return &Controller{dyn: dyn, deps: deps, ns: ns, resync: resync, log: logger}
}

// Run blocks until ctx is cancelled, reconciling on resync ticks and watch events.
// The two triggers are complementary: the ticker guarantees eventual convergence
// even if the watch drops (the resync covers any missed event), while the watch makes
// the operator react promptly to a Zone create/update/delete without waiting a full
// tick. A watch event debounces 200ms then drains the trigger channel so a burst of
// events (e.g. an apply touching several fields) collapses into one reconcileAll pass.
func (c *Controller) Run(ctx context.Context) error {
	trigger := make(chan struct{}, 1)
	go c.watch(ctx, trigger)

	ticker := time.NewTicker(c.resync)
	defer ticker.Stop()

	c.reconcileAll(ctx)
	for {
		select {
		case <-ctx.Done():
			c.log.Print("[zone] shutting down")
			return nil
		case <-ticker.C:
			c.reconcileAll(ctx)
		case <-trigger:
			time.Sleep(200 * time.Millisecond) // debounce a burst of watch events
			drain(trigger)
			c.reconcileAll(ctx)
		}
	}
}

// watch tails the Zone CR collection and pings trigger on any event. It is
// best-effort: a watch error (or a closed ResultChan, e.g. an API-server rollout)
// just re-establishes the watch after a short backoff — the resync ticker covers any
// events missed in the gap, so no event is ever load-bearing on its own. The
// non-blocking send keeps a single pending trigger (the buffered channel) rather than
// blocking the watch loop.
func (c *Controller) watch(ctx context.Context, trigger chan<- struct{}) {
	for ctx.Err() == nil {
		w, err := c.dyn.Resource(GVR).Namespace(c.ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			c.log.Printf("[zone] watch error (will retry, resync covers the gap): %v", err)
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

// reconcileAll lists every Zone in the namespace and reconciles each one. A list
// failure or a per-CR decode/reconcile error is logged and does not abort the pass
// (the other Zones still reconcile); the next tick/event retries. lastSync/lastErr
// feed Healthy() for the /healthz probe.
func (c *Controller) reconcileAll(ctx context.Context) {
	list, err := c.dyn.Resource(GVR).Namespace(c.ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		c.lastErr = err
		c.log.Printf("[zone] list Zones: %v", err)
		return
	}
	for i := range list.Items {
		cr, cerr := FromUnstructured(&list.Items[i])
		if cerr != nil {
			c.log.Printf("[zone] decode %s: %v", list.Items[i].GetName(), cerr)
			continue
		}
		requeue, rerr := c.deps.Reconcile(ctx, cr)
		c.reconciles++
		if rerr != nil {
			c.lastErr = rerr
			c.log.Printf("[zone] reconcile %s: %v", cr.Name, rerr)
			continue
		}
		if requeue {
			c.log.Printf("[zone] %s reconciled (requeued for next resync)", cr.Name)
		}
	}
	c.lastSync = c.deps.Now().Time
	c.lastErr = nil
}

// Healthy reports whether a recent successful sync completed — the liveness signal
// behind /healthz. It tolerates up to 3 missed resync intervals before reporting
// unhealthy (a transient list blip shouldn't flap the probe); before the first sync
// it reports healthy so a slow start isn't killed.
func (c *Controller) Healthy() bool {
	if c.lastSync.IsZero() {
		return true
	}
	return c.deps.Now().Time.Sub(c.lastSync) < 3*c.resync
}

// drain empties the trigger channel non-blockingly so a debounced burst of watch
// events collapses into the single reconcileAll pass that follows.
func drain(ch <-chan struct{}) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}
