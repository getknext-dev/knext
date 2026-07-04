package appdb

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// HTTPPageserver talks to the pageserver management API (:9898) over the in-cluster
// Service DNS (http://pageserver:9898), exactly as pswatcher does — no in-pod exec.
type HTTPPageserver struct {
	BaseURL string // http://pageserver:9898
	Client  *http.Client
}

// NewHTTPPageserver builds a pageserver client with a bounded per-request timeout.
func NewHTTPPageserver(baseURL string, timeout time.Duration) *HTTPPageserver {
	return &HTTPPageserver{BaseURL: baseURL, Client: &http.Client{Timeout: timeout}}
}

func (p *HTTPPageserver) do(ctx context.Context, method, url string, body []byte) (int, []byte, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, r)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, nil
}

func (p *HTTPPageserver) TimelineExists(ctx context.Context, tenant, tl string) (bool, error) {
	code, data, err := p.do(ctx, http.MethodGet, fmt.Sprintf("%s/v1/tenant/%s/timeline", p.BaseURL, tenant), nil)
	if err != nil {
		return false, err
	}
	if code != http.StatusOK {
		return false, fmt.Errorf("list timelines: pageserver %d: %s", code, string(data))
	}
	var list []struct {
		TimelineID string `json:"timeline_id"`
	}
	if err := json.Unmarshal(data, &list); err != nil {
		return false, fmt.Errorf("decode timelines: %w", err)
	}
	for _, t := range list {
		if t.TimelineID == tl {
			return true, nil
		}
	}
	return false, nil
}

func (p *HTTPPageserver) TemplateLastLSN(ctx context.Context, tenant, template string) (string, error) {
	code, data, err := p.do(ctx, http.MethodGet, fmt.Sprintf("%s/v1/tenant/%s/timeline/%s", p.BaseURL, tenant, template), nil)
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		return "", fmt.Errorf("get template timeline: pageserver %d: %s", code, string(data))
	}
	var t struct {
		LastRecordLSN string `json:"last_record_lsn"`
	}
	if err := json.Unmarshal(data, &t); err != nil {
		return "", fmt.Errorf("decode template timeline: %w", err)
	}
	return t.LastRecordLSN, nil
}

func (p *HTTPPageserver) Branch(ctx context.Context, tenant, tl, template, lsn string, pgVersion int) error {
	body, _ := json.Marshal(map[string]any{
		"new_timeline_id":      tl,
		"ancestor_timeline_id": template,
		"ancestor_start_lsn":   lsn,
		"pg_version":           pgVersion,
	})
	code, data, err := p.do(ctx, http.MethodPost, fmt.Sprintf("%s/v1/tenant/%s/timeline/", p.BaseURL, tenant), body)
	if err != nil {
		return err
	}
	if code < 200 || code >= 300 {
		return fmt.Errorf("branch %s: pageserver %d: %s", tl, code, string(data))
	}
	return nil
}

func (p *HTTPPageserver) DeleteTimeline(ctx context.Context, tenant, tl string) error {
	code, data, err := p.do(ctx, http.MethodDelete, fmt.Sprintf("%s/v1/tenant/%s/timeline/%s", p.BaseURL, tenant, tl), nil)
	if err != nil {
		return err
	}
	if code == http.StatusNotFound { // already gone == success for reclaim
		return nil
	}
	if code < 200 || code >= 300 {
		return fmt.Errorf("delete timeline %s: pageserver %d: %s", tl, code, string(data))
	}
	return nil
}

// HTTPSafekeeper DELETEs a timeline's WAL on each safekeeper pod via the headless
// Service DNS (safekeeper-<ord>.<svc>.<ns>.svc:7676). Two-sided delete (pageserver
// + all safekeepers) is what keeps deprovision from leaking WAL (issue #91).
type HTTPSafekeeper struct {
	Namespace string
	Service   string // headless Service name (default "safekeeper")
	Port      int    // 7676
	NReplicas int
	Client    *http.Client
}

// NewHTTPSafekeeper builds a safekeeper client for a StatefulSet of nReplicas pods.
func NewHTTPSafekeeper(namespace, service string, port, nReplicas int, timeout time.Duration) *HTTPSafekeeper {
	return &HTTPSafekeeper{Namespace: namespace, Service: service, Port: port, NReplicas: nReplicas, Client: &http.Client{Timeout: timeout}}
}

func (s *HTTPSafekeeper) Replicas() int { return s.NReplicas }

func (s *HTTPSafekeeper) DeleteTimeline(ctx context.Context, ordinal int, tenant, tl string) error {
	url := fmt.Sprintf("http://%s-%d.%s.%s.svc:%d/v1/tenant/%s/timeline/%s",
		s.Service, ordinal, s.Service, s.Namespace, s.Port, tenant, tl)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return err
	}
	resp, err := s.Client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound { // this SK never held the timeline
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("safekeeper-%d delete %s: %s", ordinal, tl, resp.Status)
	}
	return nil
}
