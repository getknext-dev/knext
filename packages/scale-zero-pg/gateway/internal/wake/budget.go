package wake

// budget.go — the per-app WAKE budget (issue #116, ADR-0008).
//
// The apps-gateway holds NO tenant credentials by design: it is a dumb byte pipe
// after the handshake, and the compute verifies auth once awake (ADR-0003 layer 2,
// reinforced by #117 SCRAM). That property is deliberate (CLAUDE.md rule 5 — don't
// rebuild what Neon gives free; the gateway never becomes a credential holder). Its
// cost: a syntactically-valid (user,database) startup passes the pre-wake authz
// (authz.go) and can SCALE compute-<app> 0->1 before any password is checked. Post
// #112 that is a *denial/cost* side-channel (force-wake churn / noisy-neighbour
// DoS), not a confidentiality break.
//
// This is the CNI-independent control for that side-channel: a per-app token-bucket
// rate limiter on the WAKE primitive itself. A caller may still wake a sleeping app
// (the wake-on-connect UX is preserved), but cannot force unbounded 0->1 churn — a
// burst beyond GW_WAKE_BUDGET is REFUSED without scaling, and the refusal is
// counted + alerted (WakeBudgetExceeded, plane=apps). The network-layer control
// (NetworkPolicy restricting who can even reach pggw-apps) is #118 (needs a
// policy-capable CNI) and is documented, not implemented here.

import (
	"errors"
	"strconv"
	"sync"
	"time"
)

// ErrWakeBudgetExceeded is returned by a WakeGuard when a compute key has exhausted
// its per-app wake budget. ConnectWithWake surfaces it WITHOUT scaling; the gateway
// maps it to a clean, transient refusal (SQLSTATE 53400) and increments the
// wake-budget-exceeded metric. Distinct from a wake FAILURE (a real cold-start
// error) so the two never share an alert.
var ErrWakeBudgetExceeded = errors.New("wake budget exceeded")

// WakeLimiter is a per-key (per-app) token-bucket rate limiter for the wake
// primitive. Each key gets an independent bucket of `capacity` tokens that refills
// at `capacity` tokens per window — so a key gets a burst of `capacity` immediate
// wakes, then a sustained ceiling of `capacity` wakes per window. One busy/hostile
// key cannot drain another's budget. Safe for concurrent use.
//
// A nil *WakeLimiter means the budget is OFF: Allow always returns true, so every
// lane that does not set GW_WAKE_BUDGET keeps the exact pre-#116 wake behaviour.
type WakeLimiter struct {
	capacity    float64
	refillPerMs float64

	mu      sync.Mutex
	buckets map[string]*wakeBucket
	now     func() time.Time // injectable clock (tests); defaults to time.Now
}

type wakeBucket struct {
	tokens float64
	last   time.Time
}

// NewWakeLimiter builds a limiter giving each key `budget` burst wakes that refill
// over `window`. budget <= 0 returns nil (budget disabled). A non-positive window
// defaults to one minute.
func NewWakeLimiter(budget int, window time.Duration) *WakeLimiter {
	if budget <= 0 {
		return nil
	}
	if window <= 0 {
		window = time.Minute
	}
	windowMs := float64(window.Milliseconds())
	if windowMs <= 0 {
		windowMs = 1
	}
	return &WakeLimiter{
		capacity:    float64(budget),
		refillPerMs: float64(budget) / windowMs,
		buckets:     map[string]*wakeBucket{},
		now:         time.Now,
	}
}

// NewWakeLimiterFromEnv reads GW_WAKE_BUDGET (burst wakes per app, 0/unset =
// disabled) and GW_WAKE_WINDOW_MS (refill window, default 60000) from env.
func NewWakeLimiterFromEnv(env Env) *WakeLimiter {
	budget, err := strconv.Atoi(env.get("GW_WAKE_BUDGET", "0"))
	if err != nil || budget <= 0 {
		return nil
	}
	windowMs, err := strconv.Atoi(env.get("GW_WAKE_WINDOW_MS", "60000"))
	if err != nil || windowMs <= 0 {
		windowMs = 60000
	}
	return NewWakeLimiter(budget, time.Duration(windowMs)*time.Millisecond)
}

// Allow reports whether a wake for key may proceed, consuming one token if so. A
// nil limiter (budget off) always allows. Refills the key's bucket by the elapsed
// time before checking, capped at capacity.
func (l *WakeLimiter) Allow(key string) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	b := l.buckets[key]
	if b == nil {
		// First wake for this key: a full bucket, minus the one we grant now.
		l.buckets[key] = &wakeBucket{tokens: l.capacity - 1, last: t}
		return true
	}
	if elapsedMs := float64(t.Sub(b.last).Milliseconds()); elapsedMs > 0 {
		b.tokens += elapsedMs * l.refillPerMs
		if b.tokens > l.capacity {
			b.tokens = l.capacity
		}
		b.last = t
	}
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}
