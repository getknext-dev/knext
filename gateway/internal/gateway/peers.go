package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// k8sPeers sums active_connections across all gateway pods (label-selected)
// by querying each pod's metrics endpoint directly, excluding this pod.
// Any listing/scrape failure is returned as an error — the caller treats
// errors as "don't sleep", biasing toward keeping a possibly-used compute up.
type k8sPeers struct {
	client      kubernetes.Interface
	namespace   string
	selector    string
	selfIP      string
	metricsPort int
	http        *http.Client
}

// NewK8sPeers builds a PeerChecker from in-cluster config. Returns nil (no
// peer checking) when not running in a cluster or selector is empty.
func NewK8sPeers(namespace, selector, selfIP string, metricsPort int) (PeerChecker, error) {
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
	}, nil
}

func (p *k8sPeers) ActiveConnections(ctx context.Context) (int, error) {
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
		n, err := p.scrape(ctx, ip)
		if err != nil {
			return 0, fmt.Errorf("peer %s: %w", pod.Name, err)
		}
		total += n
	}
	return total, nil
}

func (p *k8sPeers) scrape(ctx context.Context, ip string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://%s:%d/metrics.json", ip, p.metricsPort), nil)
	if err != nil {
		return 0, err
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var m struct {
		ActiveConnections int `json:"active_connections"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return 0, err
	}
	return m.ActiveConnections, nil
}
