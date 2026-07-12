package wake

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// transientErr is a stand-in apiserver blip (TLS handshake timeout / 5xx /
// context deadline) that the scale call must RETRY, not surface to the client.
var transientErr = k8serrors.NewServerTimeout(schema.GroupResource{Resource: "deployments"}, "get", 1)

// ---- isTerminalWakeErr classification --------------------------------------

func TestIsTerminalWakeErrClassifiesTerminalVsTransient(t *testing.T) {
	gr := schema.GroupResource{Resource: "deployments"}
	terminal := map[string]error{
		"NotFound":  k8serrors.NewNotFound(gr, "compute-orders"),
		"Forbidden": k8serrors.NewForbidden(gr, "compute-orders", errors.New("rbac")),
		"budget":    ErrWakeBudgetExceeded,
	}
	for name, err := range terminal {
		if !isTerminalWakeErr(err) {
			t.Errorf("%s must be TERMINAL (fail loud, no retry)", name)
		}
	}
	transient := map[string]error{
		"ServerTimeout":   k8serrors.NewServerTimeout(gr, "get", 1),
		"TooManyRequests": k8serrors.NewTooManyRequestsError("slow down"),
		"Conflict":        k8serrors.NewConflict(gr, "compute-orders", errors.New("resourceVersion")),
		"Internal":        k8serrors.NewInternalError(errors.New("boom")),
		"network":         errors.New("net/http: TLS handshake timeout"),
		"deadline":        context.DeadlineExceeded,
	}
	for name, err := range transient {
		if isTerminalWakeErr(err) {
			t.Errorf("%s must be TRANSIENT (retry)", name)
		}
	}
	if isTerminalWakeErr(nil) {
		t.Errorf("nil must not be terminal")
	}
}

// ---- wakeWithRetry core loop -----------------------------------------------

// A scaler that fails K transient times then succeeds: the wake must retry and
// ultimately succeed, reporting the retry count.
func TestWakeWithRetryRetriesTransientThenSucceeds(t *testing.T) {
	var calls int
	fn := func(context.Context) error {
		calls++
		if calls <= 3 {
			return transientErr
		}
		return nil
	}
	opts := Opts{WakeTimeoutMs: 5000, WakeRetryBaseMs: 1}
	deadline := time.Now().Add(5 * time.Second)
	retries, err := wakeWithRetry(context.Background(), opts, deadline, Target{Key: "orders"}, fn)
	if err != nil {
		t.Fatalf("wakeWithRetry err = %v, want success after retries", err)
	}
	if calls != 4 {
		t.Fatalf("wake attempts = %d, want 4 (3 transient + 1 success)", calls)
	}
	if retries != 3 {
		t.Fatalf("reported retries = %d, want 3", retries)
	}
}

// A terminal error (deployment NotFound) must fail IMMEDIATELY with no retry.
func TestWakeWithRetryTerminalFailsImmediatelyNoRetry(t *testing.T) {
	var calls int
	nf := k8serrors.NewNotFound(schema.GroupResource{Resource: "deployments"}, "compute-orders")
	fn := func(context.Context) error {
		calls++
		return nf
	}
	opts := Opts{WakeTimeoutMs: 5000, WakeRetryBaseMs: 1}
	deadline := time.Now().Add(5 * time.Second)
	_, err := wakeWithRetry(context.Background(), opts, deadline, Target{Key: "orders"}, fn)
	if err == nil {
		t.Fatalf("terminal NotFound must fail")
	}
	if calls != 1 {
		t.Fatalf("terminal error attempts = %d, want 1 (NO retry)", calls)
	}
}

// A permanently-transient-failing scaler must fail BOUNDED by the wake deadline
// — never hang past GW_WAKE_TIMEOUT_MS.
func TestWakeWithRetryPermanentTransientFailsWithinBudget(t *testing.T) {
	fn := func(context.Context) error { return transientErr }
	budget := 300 * time.Millisecond
	opts := Opts{WakeTimeoutMs: int(budget / time.Millisecond), WakeRetryBaseMs: 20}
	deadline := time.Now().Add(budget)
	started := time.Now()
	_, err := wakeWithRetry(context.Background(), opts, deadline, Target{Key: "orders"}, fn)
	elapsed := time.Since(started)
	if err == nil {
		t.Fatalf("permanent transient failure must eventually fail")
	}
	if elapsed > budget+500*time.Millisecond {
		t.Fatalf("wake retry hung %v, must be bounded by budget %v", elapsed, budget)
	}
}

// OnWakeRetry must fire once per RETRIED (failed-then-retried) attempt so the
// gateway can log/count 'retried' events.
func TestWakeWithRetryInvokesOnWakeRetryPerRetry(t *testing.T) {
	var calls int
	fn := func(context.Context) error {
		calls++
		if calls <= 2 {
			return transientErr
		}
		return nil
	}
	var mu sync.Mutex
	var retryAttempts []int
	opts := Opts{
		WakeTimeoutMs:   5000,
		WakeRetryBaseMs: 1,
		OnWakeRetry: func(_ Target, attempt int, _ error) {
			mu.Lock()
			retryAttempts = append(retryAttempts, attempt)
			mu.Unlock()
		},
	}
	deadline := time.Now().Add(5 * time.Second)
	if _, err := wakeWithRetry(context.Background(), opts, deadline, Target{Key: "orders"}, fn); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(retryAttempts) != 2 {
		t.Fatalf("OnWakeRetry fired %d times (%v), want 2 (the two failed attempts)", len(retryAttempts), retryAttempts)
	}
}

// ---- #192 polish: deadline-box, cancel-metric guard, exact retry count ------

// A scaler whose Scale call HANGS (honoring its ctx) must be cancelled at the
// wake deadline so the overall wake still fails BOUNDED within GW_WAKE_TIMEOUT_MS.
// Before #192 the in-flight wakeFn ran under the un-deadlined client ctx, so a
// single hung GetScale/UpdateScale could hang the client past the whole budget.
func TestWakeWithRetryDeadlineBoxesHangingWakeFn(t *testing.T) {
	// wakeFn blocks until its per-attempt ctx is cancelled — i.e. it HONORS the
	// context, exactly as client-go's GetScale/UpdateScale do.
	fn := func(c context.Context) error {
		<-c.Done()
		return c.Err()
	}
	budget := 200 * time.Millisecond
	opts := Opts{WakeTimeoutMs: int(budget / time.Millisecond), WakeRetryBaseMs: 20}
	deadline := time.Now().Add(budget)
	done := make(chan error, 1)
	go func() {
		_, err := wakeWithRetry(context.Background(), opts, deadline, Target{Key: "orders"}, fn)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("a hung wake must fail bounded, not succeed")
		}
	case <-time.After(budget + 2*time.Second):
		t.Fatalf("hung wake was NOT deadline-boxed: wakeWithRetry did not return within budget %v", budget)
	}
}

// A client hang-up (ctx cancel) DURING backoff must NOT bump the retry metric:
// OnWakeRetry counts genuine retries, and a cancel is a cancel — not a retry.
func TestWakeWithRetryClientCancelDoesNotCountAsRetry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var retryCalls int32
	fn := func(context.Context) error {
		// Fail transiently, then cancel the client ctx so the loop bails in backoff.
		cancel()
		return transientErr
	}
	opts := Opts{
		WakeTimeoutMs:   5000,
		WakeRetryBaseMs: 50, // long enough that the ctx cancel wins the backoff select
		OnWakeRetry: func(_ Target, _ int, _ error) {
			atomic.AddInt32(&retryCalls, 1)
		},
	}
	deadline := time.Now().Add(5 * time.Second)
	if _, err := wakeWithRetry(ctx, opts, deadline, Target{Key: "orders"}, fn); err == nil {
		t.Fatalf("a cancelled wake must fail")
	}
	if n := atomic.LoadInt32(&retryCalls); n != 0 {
		t.Fatalf("OnWakeRetry fired %d times on a client cancel, want 0 (cancel is not a retry)", n)
	}
}

// The returned retry count must be EXACT — equal to (total wakeFn calls - 1) —
// including the path where the deadline passes during the final backoff. Before
// #192 that path returned `attempt` (off by one) instead of `attempt - 1`.
func TestWakeWithRetryReportsExactRetryCountAtDeadline(t *testing.T) {
	var calls int32
	fn := func(context.Context) error {
		atomic.AddInt32(&calls, 1)
		return transientErr
	}
	budget := 200 * time.Millisecond
	opts := Opts{WakeTimeoutMs: int(budget / time.Millisecond), WakeRetryBaseMs: 30, WakeMaxAttempts: 100}
	deadline := time.Now().Add(budget)
	retries, err := wakeWithRetry(context.Background(), opts, deadline, Target{Key: "orders"}, fn)
	if err == nil {
		t.Fatalf("a permanent transient failure must fail")
	}
	total := int(atomic.LoadInt32(&calls))
	if retries != total-1 {
		t.Fatalf("reported retries = %d, want total_calls-1 = %d (off-by-one in the deadline path)", retries, total-1)
	}
}

// ---- ConnectWithWake end-to-end through a transient window -----------------

// wakeListenerDriver simulates a compute that is asleep (port closed) until the
// Kth wake call succeeds and brings up a listener. Wake fails transiently the
// first `failures` times — proving a cold client wake survives a transient
// apiserver window instead of failing on the first blip.
type wakeListenerDriver struct {
	mu       sync.Mutex
	failures int
	calls    int
	addr     string
	ln       net.Listener
}

func (d *wakeListenerDriver) Mode() string                        { return "test" }
func (d *wakeListenerDriver) Resolve(string) Target               { return Target{} }
func (d *wakeListenerDriver) Sleep(context.Context, Target) error { return nil }
func (d *wakeListenerDriver) CanSleep() bool                      { return true }
func (d *wakeListenerDriver) Wake(_ context.Context, _ Target) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls++
	if d.calls <= d.failures {
		return transientErr
	}
	if d.ln == nil {
		ln, err := net.Listen("tcp", d.addr)
		if err != nil {
			return err
		}
		d.ln = ln
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				_ = c.Close()
			}
		}()
	}
	return nil
}

func TestConnectWithWakeSucceedsThroughTransientScaleWindow(t *testing.T) {
	// Grab a free port, then close it so the initial TryConnect fails (compute asleep).
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	addr := probe.Addr().String()
	host, port := ParseHostPort(addr, 0)
	_ = probe.Close()

	d := &wakeListenerDriver{failures: 3, addr: addr}
	defer func() {
		if d.ln != nil {
			_ = d.ln.Close()
		}
	}()

	opts := Opts{
		ConnectTimeoutMs: 100,
		RetryMs:          10,
		WakeTimeoutMs:    5000,
		WakeRetryBaseMs:  5,
	}
	tgt := Target{Host: host, Port: port, Key: "orders"}
	conn, woke, wakeMs, err := ConnectWithWake(context.Background(), d, tgt, opts, nil)
	if err != nil {
		t.Fatalf("cold wake through transient window failed: %v (calls=%d)", err, d.calls)
	}
	if !woke {
		t.Fatalf("expected woke=true on a cold wake")
	}
	if conn == nil {
		t.Fatalf("expected a live conn")
	}
	_ = conn.Close()
	if d.calls < 4 {
		t.Fatalf("wake was called %d times, expected retry past the 3 transient failures", d.calls)
	}
	_ = wakeMs
}

// A terminal wake error surfaces immediately from ConnectWithWake with no retry
// churn (mirrors the wake-budget fast-fail, but for a real terminal apiserver error).
func TestConnectWithWakeTerminalErrorFailsImmediately(t *testing.T) {
	nf := k8serrors.NewNotFound(schema.GroupResource{Resource: "deployments"}, "compute-orders")
	var calls int
	d := &funcDriver{wake: func(context.Context, Target) error { calls++; return nf }}
	opts := Opts{ConnectTimeoutMs: 100, RetryMs: 10, WakeTimeoutMs: 5000, WakeRetryBaseMs: 5}
	// Point at a closed port so the initial TryConnect fails and the wake path runs.
	tgt := Target{Host: "127.0.0.1", Port: 1, Key: "orders"}
	_, _, _, err := ConnectWithWake(context.Background(), d, tgt, opts, nil)
	if err == nil {
		t.Fatalf("terminal NotFound must surface as an error")
	}
	if calls != 1 {
		t.Fatalf("terminal wake called %d times, want 1 (no retry)", calls)
	}
}

// funcDriver is a minimal Driver whose Wake is a supplied closure.
type funcDriver struct {
	wake func(context.Context, Target) error
}

func (d *funcDriver) Mode() string                             { return "test" }
func (d *funcDriver) Resolve(string) Target                    { return Target{} }
func (d *funcDriver) Wake(ctx context.Context, t Target) error { return d.wake(ctx, t) }
func (d *funcDriver) Sleep(context.Context, Target) error      { return nil }
func (d *funcDriver) CanSleep() bool                           { return true }
