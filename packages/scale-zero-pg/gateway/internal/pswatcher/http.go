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
// seed/heal path and the failover corroboration vantage. Points at the ROUTED
// pageserver (the client Service whose selector the failover flips), never the
// fixed primary — pointing it at the pre-failover primary is a demoted, stale
// vantage after a failover, and is banned by deploy/_validate.sh.
type HTTPGenerationViewer struct {
	BaseURL string // e.g. http://pageserver:9898 (the routed client Service)
	Client  *http.Client
}

// NewHTTPGenerationViewer builds a viewer with a bounded per-request timeout.
func NewHTTPGenerationViewer(baseURL string, timeout time.Duration) *HTTPGenerationViewer {
	return &HTTPGenerationViewer{BaseURL: baseURL, Client: &http.Client{Timeout: timeout}}
}

// Generation returns the tenant's generation as the pageserver reports it. ok=false
// when the tenant is absent (404) or the response carries no generation field. A
// transport/HTTP error is returned so the caller can leave the ledger untouched
// rather than floor it on an unavailable vantage.
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
	// The on-cluster failover drill (#1101) asserts the field is present.
	var body struct {
		Generation *int `json:"generation"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, false, fmt.Errorf("generation %s: decode: %w", tenant, err)
	}
	if body.Generation == nil {
		return 0, false, nil // no generation field — treat as unknown, not zero
	}
	return *body.Generation, true, nil
}
