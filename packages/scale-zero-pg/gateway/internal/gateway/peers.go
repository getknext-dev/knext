package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// k8sPeers sums the PER-APP active connection count across all gateway pods
// (label-selected) by querying each pod's metrics endpoint directly, excluding
// this pod. It reads the per-system counter for a specific target key — NOT the
// fleet-global scalar — so one busy app never keeps a different idle app awake
// (issue #75). Any listing/scrape failure is returned as an error — the caller
// treats errors as "don't sleep", biasing toward keeping a possibly-used compute up.
type k8sPeers struct {
	client      kubernetes.Interface
	namespace   string
	selector    string
	selfIP      string
	metricsPort int
	http        *http.Client
	// peerToken is the shared fleet bearer token (F6, GW_PEER_TOKEN) sent on each
	// peer scrape. Empty only when peer-scrape auth is explicitly disabled (dev).
	peerToken string
	// logf logs a peer auth mismatch (401); nil-safe (defaults to log.Printf).
	logf func(format string, args ...any)
}

// NewK8sPeers builds a PeerChecker from in-cluster config. Returns nil (no
// peer checking) when not running in a cluster or selector is empty. peerToken
// (GW_PEER_TOKEN, F6) authenticates the scrape against each peer's /metrics.json.
func NewK8sPeers(namespace, selector, selfIP string, metricsPort int, peerToken string) (PeerChecker, error) {
	if selector == "" || namespace == "" {
		return nil, nil
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, nil // not in-cluster (local dev): single-replica semantics
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &k8sPeers{
		client:      client,
		namespace:   namespace,
		selector:    selector,
		selfIP:      selfIP,
		metricsPort: metricsPort,
		http:        &http.Client{Timeout: 2 * time.Second},
		peerToken:   peerToken,
		logf:        log.Printf,
	}, nil
}

// ActiveConnections reports the number of connections open on PEER gateways for
// the given target key (system/app). It is keyed per-app so the sleep decision
// for app X is not held up by an unrelated busy app Y on another replica.
func (p *k8sPeers) ActiveConnections(ctx context.Context, key string) (int, error) {
	pods, err := p.client.CoreV1().Pods(p.namespace).List(ctx, metav1.ListOptions{LabelSelector: p.selector})
	if err != nil {
		return 0, fmt.Errorf("list peer pods: %w", err)
	}
	total := 0
	for _, pod := range pods.Items {
		ip := pod.Status.PodIP
		if ip == "" || ip == p.selfIP {
			continue
		}
		n, err := p.scrape(ctx, ip, key)
		if err != nil {
			return 0, fmt.Errorf("peer %s: %w", pod.Name, err)
		}
		total += n
	}
	return total, nil
}

// scrape returns the peer's active connection count for exactly this key, read
// from the per_system map in /metrics.json. An absent key means the peer has no
// connections for that app -> 0 (not an error).
func (p *k8sPeers) scrape(ctx context.Context, ip, key string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://%s:%d/metrics.json", ip, p.metricsPort), nil)
	if err != nil {
		return 0, err
	}
	// F6: authenticate the scrape with the shared fleet bearer token.
	if p.peerToken != "" {
		req.Header.Set("Authorization", "Bearer "+p.peerToken)
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	// C1 (LOAD-BEARING): check status BEFORE decoding. Any non-200 is a real
	// error so the idle caller's err!=nil branch POSTPONES sleep (keeps the
	// compute awake). Decoding a 401 body would yield Active=0 and wrongly scale
	// an active DB to zero — the bug this guards. On 401 (peer auth mismatch,
	// e.g. mid-rotation) log it, then return the error as "peer unknown".
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusUnauthorized && p.logf != nil {
			p.logf("[gw] peer %s: /metrics.json 401 — peer auth token mismatch (rotation?); treating peer as unknown, postponing sleep", ip)
		}
		return 0, fmt.Errorf("peer %s: /metrics.json status %d", ip, resp.StatusCode)
	}
	var m struct {
		PerSystem map[string]struct {
			Active int `json:"active"`
		} `json:"per_system"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return 0, err
	}
	return m.PerSystem[key].Active, nil
}
