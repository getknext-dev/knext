package gateway

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// statusProbe is the DETERMINISTIC cold-boot readiness gate (issue #174), a
// follow-up to #132's blind time-based settle. compute_ctl exposes an HTTP
// /status endpoint (default port 3080) reporting a lifecycle `status`: it flips to
// "running" ONLY once the compute has fully applied its spec — the per-app roles
// and passwords that the #132 settle merely waits a fixed 250ms for. Polling that
// signal until "running" (or the wake deadline) closes the role-apply race
// deterministically instead of heuristically.
//
// It is OPT-IN. compute_ctl's /status is JWT-gated (probed live: {"error":
// "invalid authorization token"}) and, in the shipped deployment, port 3080 is
// neither exposed on the compute Service nor allowed by the compute NetworkPolicy
// (only 55433/pg is). Enabling the gate therefore requires an operator to (a)
// mount a compute_ctl JWT and set GW_STATUS_TOKEN[_FILE], (b) set GW_STATUS_PORT,
// (c) expose 3080 on the compute Service + NetworkPolicy. Until then the probe is
// nil and the gateway keeps the bounded #132 settle, byte-for-byte unchanged.
type statusProbe struct {
	port         int          // compute_ctl HTTP port (3080)
	token        string       // compute_ctl JWT (Bearer)
	ready        string       // the status value meaning "spec applied" (default "running")
	pollMs       int          // poll interval between /status reads
	reqTimeoutMs int          // per-request timeout (also caps how long a hung read can block)
	timeoutMs    int          // cap on the deterministic poll (0 = use full GW_WAKE_TIMEOUT_MS budget)
	client       *http.Client // no redirects; per-request context bounds the deadline
}

// probeDeadline returns the deterministic-poll deadline: the wake deadline,
// optionally tightened to start+timeoutMs so a misconfigured/unreachable /status
// degrades to the bounded settle quickly instead of burning the whole wake budget.
// Never exceeds the wake deadline (the #132/#174 clamp invariant).
func (p *statusProbe) probeDeadline(start time.Time, wakeDeadline time.Time) time.Time {
	if p.timeoutMs <= 0 {
		return wakeDeadline
	}
	if tighter := start.Add(time.Duration(p.timeoutMs) * time.Millisecond); tighter.Before(wakeDeadline) {
		return tighter
	}
	return wakeDeadline
}

// newStatusProbe builds a probe. reqTimeoutMs bounds a single /status read so a
// hung endpoint cannot block past the wake deadline.
func newStatusProbe(port int, token, ready string, pollMs, reqTimeoutMs int) *statusProbe {
	if ready == "" {
		ready = "running"
	}
	if pollMs <= 0 {
		pollMs = 50
	}
	if reqTimeoutMs <= 0 {
		reqTimeoutMs = 1000
	}
	return &statusProbe{
		port:         port,
		token:        token,
		ready:        ready,
		pollMs:       pollMs,
		reqTimeoutMs: reqTimeoutMs,
		// Transport with no keep-alive reuse issues: each poll is a fresh short
		// request; the per-request context (not this field) enforces the deadline.
		client: &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// newStatusProbeFromEnv wires the probe from GW_STATUS_* config. Returns nil
// (gate disabled, #132 settle used) unless BOTH a port and a token are supplied —
// the token is mandatory because /status is JWT-gated, so a port alone would only
// ever get 401s. GW_STATUS_TOKEN_FILE (a mounted Secret) is preferred over the
// inline GW_STATUS_TOKEN so the JWT never lands in the pod's env listing.
func newStatusProbeFromEnv(env wake.Env) *statusProbe {
	port := envInt(env, "GW_STATUS_PORT", 0)
	if port <= 0 {
		return nil
	}
	token := ""
	if f := env["GW_STATUS_TOKEN_FILE"]; f != "" {
		if b, err := os.ReadFile(f); err == nil {
			token = strings.TrimSpace(string(b))
		}
	}
	if token == "" {
		token = strings.TrimSpace(env["GW_STATUS_TOKEN"])
	}
	if token == "" {
		return nil
	}
	ready := "running"
	if v := env["GW_STATUS_READY"]; v != "" {
		ready = v
	}
	p := newStatusProbe(
		port,
		token,
		ready,
		envInt(env, "GW_STATUS_POLL_MS", 50),
		envInt(env, "GW_STATUS_REQ_TIMEOUT_MS", 1000),
	)
	p.timeoutMs = envInt(env, "GW_STATUS_TIMEOUT_MS", 0) // 0 = full wake budget
	return p
}

// awaitReady polls http://<host>:<port>/status until compute_ctl reports the ready
// status, the deadline passes, or the JWT is definitively rejected (401/403).
// Returns true ONLY on a deterministic ready signal. It never blocks past the
// deadline: each request is bounded by min(reqTimeoutMs, time-to-deadline), and a
// 401/403 short-circuits (no amount of polling fixes a bad token — the caller then
// falls back to the bounded settle). Transient errors during boot (connection
// refused, non-ready status) keep polling until the deadline.
func (p *statusProbe) awaitReady(host string, deadline time.Time, log func(string), key string) bool {
	url := "http://" + net.JoinHostPort(host, strconv.Itoa(p.port)) + "/status"
	for {
		if !time.Now().Before(deadline) {
			log("[gw] " + key + ": /status not ready by the wake deadline — falling back to bounded settle (#174)")
			return false
		}
		ready, hardFail := p.probeOnce(url, deadline)
		if ready {
			return true
		}
		if hardFail {
			log("[gw] " + key + ": compute_ctl /status rejected the token (401/403) — falling back to bounded settle (#174)")
			return false
		}
		// Not ready yet (booting / applying spec). Sleep the poll interval, but
		// never past the deadline.
		sleep := time.Duration(p.pollMs) * time.Millisecond
		if rem := time.Until(deadline); rem < sleep {
			sleep = rem
		}
		if sleep <= 0 {
			return false
		}
		time.Sleep(sleep)
	}
}

// probeOnce does a single /status read. It returns (ready, hardFail): ready when
// the body's status == p.ready; hardFail on 401/403 (bad JWT, stop polling). All
// other outcomes (dial error, 5xx, non-ready status, unparseable body) return
// (false,false) so the caller keeps polling until the deadline.
func (p *statusProbe) probeOnce(url string, deadline time.Time) (ready, hardFail bool) {
	budget := time.Duration(p.reqTimeoutMs) * time.Millisecond
	if rem := time.Until(deadline); rem < budget {
		budget = rem
	}
	if budget <= 0 {
		return false, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, false
	}
	req.Header.Set("Authorization", "Bearer "+p.token)

	resp, err := p.client.Do(req)
	if err != nil {
		return false, false // transient during boot (refused/timeout) — keep polling
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return false, true // bad token — no point polling
	}
	if resp.StatusCode != http.StatusOK {
		return false, false
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false, false
	}
	return strings.EqualFold(body.Status, p.ready), false
}

// gateColdWake is the cold-boot readiness gate the proxy calls before replaying
// the client's startup. It fires ONLY on a genuine 0->1 cold wake (woke) of a
// per-app front door (a systemAuthorizer driver) — exactly the #132 discriminator,
// so warm connects and the base single-DB (cloud_admin) path are never touched.
//
// When the deterministic /status probe is configured it polls compute_ctl until
// the compute reports ready (bounded by GW_WAKE_TIMEOUT_MS) and proceeds the
// instant the role apply is provably done — no blind sleep. If the probe is not
// configured (the default deployment), or /status is unreachable / the token is
// rejected, it FALLS BACK to the #132 bounded settle. Deterministic-when-
// available, time-bounded-always: total added latency is clamped to the wake
// deadline in every path.
func (g *Gateway) gateColdWake(woke bool, target wake.Target, start time.Time) {
	if !woke {
		return
	}
	if _, ok := g.driver.(systemAuthorizer); !ok {
		return
	}
	// The deterministic probe (when configured) is the gate; the #132 settle is the
	// fallback. GW_ROLE_APPLY_SETTLE_MS=0 removes only the time-based fallback (via
	// settleColdWake's own guard) — with a probe configured the gate still fires.
	if g.statusProbe != nil {
		wakeDeadline := start.Add(time.Duration(g.opts.WakeTimeoutMs) * time.Millisecond)
		deadline := g.statusProbe.probeDeadline(start, wakeDeadline)
		if g.statusProbe.awaitReady(target.Host, deadline, g.log, target.Key) {
			g.log("[gw] " + target.Key + ": cold wake — compute_ctl /status reports ready, role apply confirmed (#174)")
			return
		}
		// Probe inconclusive (never-ready / unreachable / rejected). Fall through
		// to the bounded settle as a belt-and-suspenders floor.
	}
	g.settleColdWake(woke, target, start)
}
