package wake

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	k8serrors "k8s.io/apimachinery/pkg/api/errors"
)

// defaultWakeRetryBaseMs is the base exponential-backoff step used when
// Opts.WakeRetryBaseMs is unset. Small enough that a fast transient recovers
// well inside the wake budget, large enough not to hammer a struggling apiserver.
const defaultWakeRetryBaseMs = 200

// defaultWakeMaxAttempts caps the number of Scale attempts (first try + retries)
// when Opts.WakeMaxAttempts is unset. The wake DEADLINE is the real ceiling —
// this is a belt-and-braces bound so a mis-set (huge) deadline still terminates.
const defaultWakeMaxAttempts = 8

// maxWakeBackoff clamps a single backoff step so exponential growth never parks
// a retry for longer than the caller would tolerate inside a wake budget.
const maxWakeBackoff = 5 * time.Second

// isTerminalWakeErr reports whether a wake/scale error is TERMINAL — a condition
// retrying cannot fix, so the client wake must fail loud immediately rather than
// burn the wake budget. Everything else (apiserver 5xx/timeout/throttle/conflict,
// TLS handshake timeouts, context deadlines, connection resets — the whole family
// of transient OKE apiserver blips this issue targets) is retryable.
//
// GetScale→UpdateScale is idempotent (it converges replicas to the wake count),
// so a retry can only re-assert the desired state; retry-by-default is safe.
func isTerminalWakeErr(err error) bool {
	if err == nil {
		return false
	}
	// A wake-budget refusal is a deliberate decision, never a transient blip.
	if err == ErrWakeBudgetExceeded {
		return true
	}
	switch {
	case k8serrors.IsNotFound(err), // the Deployment does not exist — misconfig, not a blip
		k8serrors.IsForbidden(err),    // RBAC denies the scale — will never succeed on retry
		k8serrors.IsUnauthorized(err), // auth rejected — retrying spins uselessly
		k8serrors.IsInvalid(err),      // the scale object is invalid
		k8serrors.IsBadRequest(err),   // malformed request
		k8serrors.IsMethodNotSupported(err),
		k8serrors.IsGone(err):
		return true
	}
	return false
}

// wakeWithRetry invokes wakeFn with bounded exponential backoff + jitter until it
// succeeds, hits a terminal error, exhausts WakeMaxAttempts, or reaches deadline.
// It returns the number of RETRIES performed (0 on a first-try success) so the
// caller can distinguish a clean wake from a retried-then-succeeded one.
//
// deadline is derived from the wake budget (GW_WAKE_TIMEOUT_MS) by the caller, so
// a genuinely-down apiserver still fails BOUNDED — never hanging past the budget.
func wakeWithRetry(ctx context.Context, opts Opts, deadline time.Time, t Target, wakeFn func(context.Context) error) (retries int, err error) {
	base := time.Duration(opts.WakeRetryBaseMs) * time.Millisecond
	if base <= 0 {
		base = defaultWakeRetryBaseMs * time.Millisecond
	}
	maxAttempts := opts.WakeMaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = defaultWakeMaxAttempts
	}

	backoff := base
	for attempt := 1; ; attempt++ {
		err = wakeFn(ctx)
		if err == nil {
			return attempt - 1, nil
		}
		// Terminal: fail loud immediately, no retry, no budget burn.
		if isTerminalWakeErr(err) {
			return attempt - 1, err
		}
		// Out of attempts — surface the last transient error, bounded.
		if attempt >= maxAttempts {
			return attempt - 1, fmt.Errorf("wake scale call failed after %d attempts: %w", attempt, err)
		}
		// Clamp the sleep to the remaining wake budget; if none is left, stop now.
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return attempt - 1, fmt.Errorf("wake scale call failed within budget after %d attempts: %w", attempt, err)
		}
		sleep := jitterBackoff(backoff)
		if sleep > remaining {
			sleep = remaining
		}
		if opts.OnWakeRetry != nil {
			opts.OnWakeRetry(t, attempt, err)
		}
		select {
		case <-ctx.Done():
			return attempt - 1, fmt.Errorf("wake scale call cancelled after %d attempts: %w", attempt, err)
		case <-time.After(sleep):
		}
		if !time.Now().Before(deadline) {
			return attempt, fmt.Errorf("wake scale call failed within budget after %d attempts: %w", attempt, err)
		}
		if backoff = backoff * 2; backoff > maxWakeBackoff {
			backoff = maxWakeBackoff
		}
	}
}

// jitterBackoff applies equal jitter (d/2 + rand[0,d/2]) to a backoff step so a
// fleet of gateways retrying a shared apiserver does not synchronise into
// thundering-herd waves.
func jitterBackoff(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	half := d / 2
	return half + time.Duration(rand.Int63n(int64(half)+1)) //nolint:gosec // jitter, not crypto
}
