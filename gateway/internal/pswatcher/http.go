package pswatcher

import (
	"bytes"
	"context"
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
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("promote %s: pageserver returned %s", tenant, resp.Status)
	}
	return nil
}
