package pswatcher

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// HTTPProber checks the primary pageserver's :9898 /v1/status. A non-200 or any
// transport error counts as "not alive" — a hung process that stops answering
// status is as dead, for reads, as a crashed one.
type HTTPProber struct {
	StatusURL string
	Client    *http.Client
}

// NewHTTPProber builds a prober with a bounded per-request timeout.
func NewHTTPProber(statusURL string, timeout time.Duration) *HTTPProber {
	return &HTTPProber{StatusURL: statusURL, Client: &http.Client{Timeout: timeout}}
}

func (p *HTTPProber) Alive(ctx context.Context) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.StatusURL, nil)
	if err != nil {
		return false
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return false
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()
	return resp.StatusCode == http.StatusOK
}

// HTTPPromoter promotes the standby pageserver by PUTting an AttachedSingle
// location_config at the given generation.
type HTTPPromoter struct {
	BaseURL string // e.g. http://pageserver-standby:9898
	Client  *http.Client
}

// NewHTTPPromoter builds a promoter with a bounded per-request timeout.
func NewHTTPPromoter(baseURL string, timeout time.Duration) *HTTPPromoter {
	return &HTTPPromoter{BaseURL: baseURL, Client: &http.Client{Timeout: timeout}}
}

func (p *HTTPPromoter) Promote(ctx context.Context, tenant string, generation int) error {
	url := fmt.Sprintf("%s/v1/tenant/%s/location_config", p.BaseURL, tenant)
	body := fmt.Sprintf(`{"mode":"AttachedSingle","generation":%d,"tenant_conf":{}}`, generation)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader([]byte(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.Client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		// The pageserver does not hold this tenant (e.g. an apps tenant that was
		// never provisioned). Signal SKIP, not a hard failure (#1098).
		return fmt.Errorf("promote %s: %w", tenant, ErrTenantNotFound)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("promote %s: pageserver returned %s", tenant, resp.Status)
	}
	return nil
}

// HTTPGenerationViewer reads a tenant's current generation from the pageserver
// (GET <BaseURL>/v1/tenant/<T>, top-level "generation"). Used by the startup
// seed/heal path and the failover corroboration vantage.
//
// Its two wired instances point at the ROUTED pageserver (the client Service whose
// selector the failover flips), never at the fixed primary — pointing it at the
// pre-failover primary is a demoted, stale vantage after a failover, and is banned by
// deploy/_validate.sh.
//
// It is deliberately NOT the standby's held/not-held oracle. GET /v1/tenant/<T>
// answers only for a tenant the pageserver holds ATTACHED; on a warm standby, whose
// routed tenants are held as SECONDARIES, it returns 503 "Tenant not yet active"
// (observed live on the szpg-f5 standby) — which this type correctly reports as an
// ERROR, and which would therefore abort every failover if it were used as the
// pre-flight. The membership oracle is HTTPTenantMembershipViewer below.
type HTTPGenerationViewer struct {
	BaseURL string // e.g. http://pageserver:9898 (the routed client Service)
	Client  *http.Client
}

// NewHTTPGenerationViewer builds a viewer with a bounded per-request timeout.
func NewHTTPGenerationViewer(baseURL string, timeout time.Duration) *HTTPGenerationViewer {
	return &HTTPGenerationViewer{BaseURL: baseURL, Client: &http.Client{Timeout: timeout}}
}

// Generation returns the tenant's generation as the pageserver reports it. ok=false
// means one thing only: the pageserver does NOT hold this tenant (404). A
// transport/HTTP error — or a 200 whose body carries no generation field
// (ErrGenerationUnreadable) — is returned as an ERROR so the caller can leave the
// ledger untouched, refuse to promote on an unreadable vantage, and never mistake
// "unverifiable" for "absent".
func (v *HTTPGenerationViewer) Generation(ctx context.Context, tenant string) (int, bool, error) {
	url := fmt.Sprintf("%s/v1/tenant/%s", v.BaseURL, tenant)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, false, err
	}
	resp, err := v.Client.Do(req)
	if err != nil {
		return 0, false, err
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return 0, false, nil // tenant not attached here — nothing to read
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, false, fmt.Errorf("generation %s: pageserver returned %s", tenant, resp.Status)
	}
	// GET /v1/tenant/<T> returns a top-level "generation" — confirmed against a live
	// GKE pageserver (neon:8464): {"id":…,"state":{"slug":"Active"},…,"generation":N,…}.
	// The on-cluster failover drill (#1117) asserts the field is present.
	var body struct {
		Generation *int `json:"generation"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, false, fmt.Errorf("generation %s: decode: %w", tenant, err)
	}
	if body.Generation == nil {
		// UNKNOWN, and unknown is an ERROR — not ok=false, which every caller reads
		// as "absent" (#1100 review, FIX 2). The pageserver answered for this tenant,
		// so it is NOT a corroborated absence; returning ok=false here would let
		// converge skip a stranded tenant silently and let skippable() treat an
		// unverifiable answer as proof the tenant does not exist.
		return 0, false, fmt.Errorf("generation %s: %w", tenant, ErrGenerationUnreadable)
	}
	return *body.Generation, true, nil
}

// HTTPTenantMembershipViewer answers ONE question about one pageserver: does it HOLD
// this tenant, in any location mode? It reads the plane-wide listing
// GET <BaseURL>/v1/location_config, whose body is
//
//	{"tenant_shards":[["<tenant-shard-id>", <location-config|null>], …]}
//
// and reports membership of the tenant id in that list.
//
// Why this endpoint and not a per-tenant one — LIVE-VERIFIED on the szpg-f5 standby,
// whose routed tenants are warm SECONDARIES:
//
//	GET /v1/tenant/<T>                 -> 503 "Tenant not yet active"
//	GET /v1/tenant/<T>/location_config -> 404, even though the tenant IS held
//	GET /v1/location_config            -> 200, and the tenant IS in tenant_shards
//
// Both per-tenant endpoints therefore report a held Secondary as absent/unreadable,
// which is exactly backwards for the failover pre-flight: a standby warmed correctly
// would read as "does not hold it" and abort (or, worse, read as absent and be
// skipped). Only the plane-wide listing sees a Secondary.
//
// It is pointed at the STANDBY (the promotion target) — the node whose tenant
// coverage must be confirmed before an irreversible attach+flip.
type HTTPTenantMembershipViewer struct {
	BaseURL string // e.g. http://pageserver-standby:9898
	Client  *http.Client
}

// NewHTTPTenantMembershipViewer builds a membership oracle with a bounded per-request
// timeout.
func NewHTTPTenantMembershipViewer(baseURL string, timeout time.Duration) *HTTPTenantMembershipViewer {
	return &HTTPTenantMembershipViewer{BaseURL: baseURL, Client: &http.Client{Timeout: timeout}}
}

// HoldsTenant reports whether the pageserver lists the tenant among the shards it
// holds. held=false means ONE thing only: the pageserver answered 200 and the tenant
// is NOT in that list. Every unreadable answer — transport failure, non-2xx (including
// 404, which says the endpoint is absent, not the tenant), an unparseable body, or a
// body with no tenant_shards field — is an ERROR, never held=false, because the caller
// treats held=false as a corroboratable absence and "we could not check" is not "it is
// not there".
//
// Matching is on the EXACT tenant id. The plane is unsharded (tenant_shards carries
// bare tenant ids there, verified live), and on a sharded plane the entries would be
// `<tenant>-<shard>` — which this reports as NOT held, so a failover aborts loudly
// rather than attaching onto an unverified standby. That is the fail-closed direction;
// sharded-id parsing is deliberately not invented ahead of a plane that uses it.
func (v *HTTPTenantMembershipViewer) HoldsTenant(ctx context.Context, tenant string) (bool, error) {
	return holdsTenantAt(ctx, v.Client, v.BaseURL, tenant)
}

// holdsTenantAt is the shared plane-wide-listing membership read: GET
// baseURL/v1/location_config, held = the exact tenant id is in tenant_shards. Both the
// fixed-URL failover oracle (HTTPTenantMembershipViewer) and the D1 reconcile's
// per-URL prober (HTTPTenantMembershipAt) call it, so the fail-closed parsing —
// unreadable is an ERROR, never absence — lives in one place.
func holdsTenantAt(ctx context.Context, client *http.Client, baseURL, tenant string) (bool, error) {
	url := fmt.Sprintf("%s/v1/location_config", baseURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, fmt.Errorf("membership %s: pageserver returned %s", tenant, resp.Status)
	}
	// Each entry is a 2-tuple [shard-id, config]; the config is null for a Secondary
	// and an object for an attached location, so only the first element is decoded.
	var body struct {
		TenantShards *[][]json.RawMessage `json:"tenant_shards"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false, fmt.Errorf("membership %s: decode: %w", tenant, err)
	}
	if body.TenantShards == nil {
		return false, fmt.Errorf("membership %s: %w", tenant, ErrTenantShardsUnreadable)
	}
	for _, entry := range *body.TenantShards {
		if len(entry) == 0 {
			return false, fmt.Errorf("membership %s: %w (empty tenant_shards entry)", tenant, ErrTenantShardsUnreadable)
		}
		var id string
		if err := json.Unmarshal(entry[0], &id); err != nil {
			return false, fmt.Errorf("membership %s: tenant_shards entry id: %w", tenant, err)
		}
		if id == tenant {
			return true, nil
		}
	}
	return false, nil
}

// HTTPTenantMembershipAt is the D1 reconcile's per-URL membership prober: it answers
// HoldsTenantAt against an EXPLICIT base URL, because the node that is currently the
// standby swaps after a failover. Same fail-closed contract as HTTPTenantMembershipViewer
// (unreadable is an ERROR, never absence); it just takes the URL per call.
type HTTPTenantMembershipAt struct {
	Client *http.Client
}

// NewHTTPTenantMembershipAt builds a per-URL membership prober with a bounded timeout.
func NewHTTPTenantMembershipAt(timeout time.Duration) *HTTPTenantMembershipAt {
	return &HTTPTenantMembershipAt{Client: &http.Client{Timeout: timeout}}
}

// HoldsTenantAt reports whether the pageserver at baseURL lists the tenant among the
// shards it holds (Secondaries included). Unreadable is an ERROR, never held=false.
func (v *HTTPTenantMembershipAt) HoldsTenantAt(ctx context.Context, baseURL, tenant string) (bool, error) {
	return holdsTenantAt(ctx, v.Client, baseURL, tenant)
}

// HTTPSecondaryWarmer registers a tenant as a WARM Secondary on the pageserver at an
// explicit base URL — the D1 reconcile's write half. It mirrors the one-shot
// standby-init Job's registration (PUT location_config mode:Secondary,
// secondary_conf.warm:true) and then kicks a layer download, best-effort. The
// REGISTRATION decides the return code; the download kick is advisory (it can
// legitimately fail on a cold bucket) so its failure is swallowed — exactly as the Job's
// warm_secondary() helper does (deploy/57).
type HTTPSecondaryWarmer struct {
	Client *http.Client
}

// NewHTTPSecondaryWarmer builds a warmer with a bounded per-request timeout.
func NewHTTPSecondaryWarmer(timeout time.Duration) *HTTPSecondaryWarmer {
	return &HTTPSecondaryWarmer{Client: &http.Client{Timeout: timeout}}
}

// WarmSecondary registers the tenant as a warm Secondary on the pageserver at baseURL,
// then kicks a download (advisory). NEVER call this against the live primary — the
// reconcile's resolveStandby guard ensures baseURL is always the standby node.
func (w *HTTPSecondaryWarmer) WarmSecondary(ctx context.Context, baseURL, tenant string) error {
	url := fmt.Sprintf("%s/v1/tenant/%s/location_config", baseURL, tenant)
	body := `{"mode":"Secondary","secondary_conf":{"warm":true},"tenant_conf":{}}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader([]byte(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := w.Client.Do(req)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		return fmt.Errorf("warm-secondary %s: pageserver returned %s", tenant, resp.Status)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	// Kick a layer download so the Secondary starts pre-fetching. Advisory: a cold bucket
	// can legitimately fail this, and it must NOT become the registration's status.
	dlURL := fmt.Sprintf("%s/v1/tenant/%s/secondary/download", baseURL, tenant)
	if dlReq, derr := http.NewRequestWithContext(ctx, http.MethodPost, dlURL, nil); derr == nil {
		if dlResp, derr := w.Client.Do(dlReq); derr == nil {
			_, _ = io.Copy(io.Discard, dlResp.Body)
			_ = dlResp.Body.Close()
		}
	}
	return nil
}
