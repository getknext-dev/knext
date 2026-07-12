/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	admissionv1 "k8s.io/api/admission/v1"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	webhookv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/webhook/v1alpha1"
)

// These tests pin the #252 fix: the manager's readiness (readyz) must gate on
// the webhook server's TLS listener, so that a Ready pod ⇒ a serving
// validating webhook (failurePolicy=Fail blocks ALL NextApp writes when the
// webhook is not serving). Liveness (healthz) must NEVER gate on the webhook:
// a pod legitimately waiting on cert-manager's cert mount must be NotReady,
// not crash-looping.

var testCfg *rest.Config
var testEnv *envtest.Environment

func TestMain(m *testing.M) {
	logf.SetLogger(zap.New(zap.WriteTo(io.Discard), zap.UseDevMode(true)))

	// Reuse the production scheme built in main.go's init() (client-go +
	// NextApp + Knative serving); admission types are needed for the webhook.
	if err := admissionv1.AddToScheme(scheme); err != nil {
		fmt.Fprintf(os.Stderr, "add scheme: %v\n", err)
		os.Exit(1)
	}

	testEnv = &envtest.Environment{
		CRDDirectoryPaths:     []string{filepath.Join("..", "config", "crd", "bases")},
		ErrorIfCRDPathMissing: true,
		// Installing the webhook config makes envtest generate local serving
		// certs (LocalServingCertDir) — the same TLS material the manager's
		// webhook server needs, exactly like cert-manager provides in-cluster.
		WebhookInstallOptions: envtest.WebhookInstallOptions{
			Paths: []string{filepath.Join("..", "config", "webhook")},
		},
	}
	if dir := firstEnvTestBinaryDir(); dir != "" {
		testEnv.BinaryAssetsDirectory = dir
	}

	var err error
	testCfg, err = testEnv.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, "start envtest: %v\n", err)
		os.Exit(1)
	}

	code := m.Run()

	if err := testEnv.Stop(); err != nil {
		fmt.Fprintf(os.Stderr, "stop envtest: %v\n", err)
	}
	os.Exit(code)
}

// newProbeManager builds a manager the way main() does: a webhook server (with
// or without serving certs) and a health-probe endpoint on a local free port.
func newProbeManager(t *testing.T, withCerts bool) (manager.Manager, string) {
	t.Helper()

	probeAddr := fmt.Sprintf("127.0.0.1:%d", freePort(t))

	webhookOpts := webhook.Options{}
	if withCerts {
		wi := testEnv.WebhookInstallOptions
		webhookOpts.Host = wi.LocalServingHost
		webhookOpts.Port = freePort(t)
		webhookOpts.CertDir = wi.LocalServingCertDir
	}

	mgr, err := manager.New(testCfg, manager.Options{
		Scheme:                 scheme,
		Metrics:                metricsserver.Options{BindAddress: "0"},
		WebhookServer:          webhook.NewServer(webhookOpts),
		HealthProbeBindAddress: probeAddr,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	return mgr, probeAddr
}

func TestReadyzGatesOnWebhookServer(t *testing.T) {
	mgr, probeAddr := newProbeManager(t, true)

	// Register the real NextApp validating webhook, as main() does when
	// --webhook-cert-path is set.
	if err := webhookv1alpha1.SetupNextAppWebhookWithManager(mgr); err != nil {
		t.Fatalf("setup webhook: %v", err)
	}

	if err := setupHealthChecks(mgr, true); err != nil {
		t.Fatalf("setupHealthChecks: %v", err)
	}

	// Before the manager (and thus the webhook TLS listener) starts, the
	// readiness checker must fail — this is the NotReady window that keeps
	// the Deployment un-Available while waiting on certs/TLS bind.
	checker := mgr.GetWebhookServer().StartedChecker()
	if err := checker(&http.Request{}); err == nil {
		t.Fatal("webhook StartedChecker passed before the webhook server started; " +
			"readyz would report Ready while the webhook cannot admit")
	}

	ctx := t.Context() // canceled at test end — stops the manager
	go func() {
		if err := mgr.Start(ctx); err != nil {
			t.Errorf("manager start: %v", err)
		}
	}()

	// Once the webhook TLS listener accepts, readyz must turn 200.
	waitForProbe(t, probeAddr, "/readyz", http.StatusOK)

	// The webhook checker must be registered under readyz…
	body := probeBody(t, probeAddr, "/readyz?verbose=1")
	if !strings.Contains(body, "webhook-started") {
		t.Fatalf("readyz does not include the webhook-started checker; verbose body:\n%s", body)
	}
	// …and must NEVER be part of livez: a pod waiting on cert-manager must
	// be NotReady, not killed.
	body = probeBody(t, probeAddr, "/healthz?verbose=1")
	if strings.Contains(body, "webhook-started") {
		t.Fatalf("healthz (liveness) includes the webhook checker — cert-wait would crash-loop; verbose body:\n%s", body)
	}
	waitForProbe(t, probeAddr, "/healthz", http.StatusOK)
}

func TestReadyzWithoutWebhookStaysPing(t *testing.T) {
	// `make run` / local dev: no --webhook-cert-path, webhook not registered.
	// setupHealthChecks(mgr, false) must not touch the webhook server at all —
	// mgr.GetWebhookServer() registers the server as a runnable, and a
	// cert-less webhook server would fail the whole manager.
	mgr, probeAddr := newProbeManager(t, false)

	if err := setupHealthChecks(mgr, false); err != nil {
		t.Fatalf("setupHealthChecks: %v", err)
	}

	ctx := t.Context() // canceled at test end — stops the manager
	go func() {
		if err := mgr.Start(ctx); err != nil {
			t.Errorf("manager start (no webhook): %v", err)
		}
	}()

	waitForProbe(t, probeAddr, "/readyz", http.StatusOK)
	body := probeBody(t, probeAddr, "/readyz?verbose=1")
	if strings.Contains(body, "webhook-started") {
		t.Fatalf("readyz gates on the webhook even though none is configured; verbose body:\n%s", body)
	}
}

func waitForProbe(t *testing.T, addr, path string, want int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		resp, err := http.Get("http://" + addr + path) //nolint:noctx // test-local probe
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == want {
				return
			}
			last = fmt.Sprintf("status %d body %q", resp.StatusCode, string(b))
		} else {
			last = err.Error()
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("GET %s never returned %d within 30s; last: %s", path, want, last)
}

func probeBody(t *testing.T, addr, path string) string {
	t.Helper()
	resp, err := http.Get("http://" + addr + path) //nolint:noctx // test-local probe
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s body: %v", path, err)
	}
	return string(b)
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer func() { _ = l.Close() }()
	return l.Addr().(*net.TCPAddr).Port
}

func firstEnvTestBinaryDir() string {
	base := filepath.Join("..", "bin", "k8s")
	entries, err := os.ReadDir(base)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() {
			return filepath.Join(base, e.Name())
		}
	}
	return ""
}
