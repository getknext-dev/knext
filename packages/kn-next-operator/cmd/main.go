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
	"crypto/tls"
	"flag"
	"fmt"
	"os"

	// Embed the IANA timezone database into the binary. The operator runtime
	// image is gcr.io/distroless/static:nonroot (Dockerfile), which ships NO
	// /usr/share/zoneinfo — so without this blank import time.LoadLocation() for
	// any non-UTC zone returns an error at runtime. The scheduled warm-floor
	// (ADR-0030, #380) resolves each warmSchedule window's timezone via
	// LoadLocation; without embedded tzdata a non-UTC window would silently
	// fail-open (the window is skipped, the warm floor never engages). ~450KB
	// binary bump, acceptable. Dev hosts have system tzdata so tests pass either
	// way — this import is what makes the SHIPPED distroless image correct.
	_ "time/tzdata"

	// Import all Kubernetes client auth plugins (e.g. Azure, GCP, OIDC, etc.)
	// to ensure that exec-entrypoint and run can make use of them.
	_ "k8s.io/client-go/plugin/pkg/client/auth"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/controller"
	webhookv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/webhook/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	// +kubebuilder:scaffold:imports
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))

	utilruntime.Must(appsv1alpha1.AddToScheme(scheme))
	utilruntime.Must(servingv1.AddToScheme(scheme))
	// +kubebuilder:scaffold:scheme
}

// nolint:gocyclo
func main() {
	var metricsAddr string
	var metricsCertPath, metricsCertName, metricsCertKey string
	var webhookCertPath, webhookCertName, webhookCertKey string
	var enableLeaderElection bool
	var probeAddr string
	var secureMetrics bool
	var enableHTTP2 bool
	var tlsOpts []func(*tls.Config)
	flag.StringVar(&metricsAddr, "metrics-bind-address", "0", "The address the metrics endpoint binds to. "+
		"Use :8443 for HTTPS or :8080 for HTTP, or leave as 0 to disable the metrics service.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", false,
		"Enable leader election for controller manager. "+
			"Enabling this will ensure there is only one active controller manager.")
	flag.BoolVar(&secureMetrics, "metrics-secure", true,
		"If set, the metrics endpoint is served securely via HTTPS. Use --metrics-secure=false to use HTTP instead.")
	flag.StringVar(&webhookCertPath, "webhook-cert-path", "", "The directory that contains the webhook certificate.")
	flag.StringVar(&webhookCertName, "webhook-cert-name", "tls.crt", "The name of the webhook certificate file.")
	flag.StringVar(&webhookCertKey, "webhook-cert-key", "tls.key", "The name of the webhook key file.")
	flag.StringVar(&metricsCertPath, "metrics-cert-path", "",
		"The directory that contains the metrics server certificate.")
	flag.StringVar(&metricsCertName, "metrics-cert-name", "tls.crt", "The name of the metrics server certificate file.")
	flag.StringVar(&metricsCertKey, "metrics-cert-key", "tls.key", "The name of the metrics server key file.")
	flag.BoolVar(&enableHTTP2, "enable-http2", false,
		"If set, HTTP/2 will be enabled for the metrics and webhook servers")
	opts := zap.Options{
		Development: true,
	}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	// if the enable-http2 flag is false (the default), http/2 should be disabled
	// due to its vulnerabilities. More specifically, disabling http/2 will
	// prevent from being vulnerable to the HTTP/2 Stream Cancellation and
	// Rapid Reset CVEs. For more information see:
	// - https://github.com/advisories/GHSA-qppj-fm5r-hxr3
	// - https://github.com/advisories/GHSA-4374-p667-p6c8
	disableHTTP2 := func(c *tls.Config) {
		setupLog.Info("Disabling HTTP/2")
		c.NextProtos = []string{"http/1.1"}
	}

	if !enableHTTP2 {
		tlsOpts = append(tlsOpts, disableHTTP2)
	}

	// Initial webhook TLS options
	webhookTLSOpts := tlsOpts
	webhookServerOptions := webhook.Options{
		TLSOpts: webhookTLSOpts,
	}

	if len(webhookCertPath) > 0 {
		setupLog.Info("Initializing webhook certificate watcher using provided certificates",
			"webhook-cert-path", webhookCertPath, "webhook-cert-name", webhookCertName, "webhook-cert-key", webhookCertKey)

		webhookServerOptions.CertDir = webhookCertPath
		webhookServerOptions.CertName = webhookCertName
		webhookServerOptions.KeyName = webhookCertKey
	}

	webhookServer := webhook.NewServer(webhookServerOptions)

	// Metrics endpoint is enabled in 'config/default/kustomization.yaml'. The Metrics options configure the server.
	// More info:
	// - https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.23.1/pkg/metrics/server
	// - https://book.kubebuilder.io/reference/metrics.html
	metricsServerOptions := metricsserver.Options{
		BindAddress:   metricsAddr,
		SecureServing: secureMetrics,
		TLSOpts:       tlsOpts,
	}

	if secureMetrics {
		// FilterProvider is used to protect the metrics endpoint with authn/authz.
		// These configurations ensure that only authorized users and service accounts
		// can access the metrics endpoint. The RBAC are configured in 'config/rbac/kustomization.yaml'. More info:
		// https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.23.1/pkg/metrics/filters#WithAuthenticationAndAuthorization
		metricsServerOptions.FilterProvider = filters.WithAuthenticationAndAuthorization
	}

	// If the certificate is not specified, controller-runtime will automatically
	// generate self-signed certificates for the metrics server. While convenient for development and testing,
	// this setup is not recommended for production.
	//
	// To use cert-manager-managed certificates for the metrics server instead of
	// the self-signed default, enable [METRICS-WITH-CERTS] in
	// config/default/kustomization.yaml (generate + mount the cert) and
	// [PROMETHEUS-WITH-CERTS] in config/prometheus/kustomization.yaml (verified TLS
	// scrape). The provided-cert path is handled below.
	if len(metricsCertPath) > 0 {
		setupLog.Info("Initializing metrics certificate watcher using provided certificates",
			"metrics-cert-path", metricsCertPath, "metrics-cert-name", metricsCertName, "metrics-cert-key", metricsCertKey)

		metricsServerOptions.CertDir = metricsCertPath
		metricsServerOptions.CertName = metricsCertName
		metricsServerOptions.KeyName = metricsCertKey
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(),
		buildManagerOptions(enableLeaderElection, metricsServerOptions, webhookServer, probeAddr))
	if err != nil {
		setupLog.Error(err, "Failed to start manager")
		os.Exit(1)
	}

	if err := (&controller.NextAppReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("nextapp-controller"),
		Cleaner:  controller.NewDefaultCleaner(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "NextApp")
		os.Exit(1)
	}

	// Register the NextApp validating admission webhook only when serving certs
	// are configured. Without certs the webhook server cannot serve TLS, so we
	// skip registration to keep `make run` / local development working. In a
	// cluster, cert-manager mounts the cert and --webhook-cert-path is set, so
	// the webhook is active and rejects invalid NextApps at admission time.
	if len(webhookCertPath) > 0 {
		if err := webhookv1alpha1.SetupNextAppWebhookWithManager(mgr); err != nil {
			setupLog.Error(err, "Failed to create webhook", "webhook", "NextApp")
			os.Exit(1)
		}
	} else {
		setupLog.Info("Skipping NextApp webhook registration: no --webhook-cert-path configured")
	}
	// +kubebuilder:scaffold:builder

	if err := setupHealthChecks(mgr, len(webhookCertPath) > 0); err != nil {
		setupLog.Error(err, "Failed to set up health/ready checks")
		os.Exit(1)
	}

	setupLog.Info("Starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "Failed to run manager")
		os.Exit(1)
	}
}

// leaderElectionID is the coordination.k8s.io Lease name the operator contends
// on. It MUST stay stable across releases: a changed ID would let an old and a
// new revision each acquire "their own" lease and reconcile simultaneously —
// exactly the split-brain leader election exists to prevent (single-writer,
// ADR-0001).
const leaderElectionID = "2dd0b3e2.kn-next.dev"

// buildManagerOptions assembles the controller-manager options (issue #307 HA).
//
// Isolated from main() so leader-election configuration is unit-testable without
// standing up a real manager. Leader election makes the operator horizontally
// available: run 2+ replicas, but only the current Lease holder reconciles, so
// there is still exactly ONE active writer (ADR-0001) while the standby is a
// warm spare ready to take over.
//
// LeaderElectionReleaseOnCancel is enabled: when a leader is gracefully stopped
// (rolling update, node drain, SIGTERM), it hands the Lease back on the way out
// so the standby acquires it immediately instead of waiting a full LeaseDuration
// (~15s) for the stale lease to expire. This is SAFE because main() does no work
// after mgr.Start() returns — the process exits the instant the manager stops.
func buildManagerOptions(
	enableLeaderElection bool,
	metricsServerOptions metricsserver.Options,
	webhookServer webhook.Server,
	probeAddr string,
) ctrl.Options {
	return ctrl.Options{
		Scheme:                        scheme,
		Metrics:                       metricsServerOptions,
		WebhookServer:                 webhookServer,
		HealthProbeBindAddress:        probeAddr,
		LeaderElection:                enableLeaderElection,
		LeaderElectionID:              leaderElectionID,
		LeaderElectionReleaseOnCancel: true,
	}
}

// setupHealthChecks wires the manager's health/readiness endpoints (#252).
//
// Liveness (/healthz) is ALWAYS a plain Ping: a pod waiting on cert-manager's
// cert mount is alive and must stay NotReady — never crash-loop.
//
// Readiness (/readyz) additionally gates on the webhook server's TLS listener
// (controller-runtime's StartedChecker, which TLS-dials the serving port) when
// the webhook is configured. The NextApp validating webhook has
// failurePolicy=Fail, so a Ready pod whose webhook is not yet serving blocks
// ALL NextApp writes with "connection refused" (#233). With this check,
// Deployment Available ⇒ webhook admission works, which makes every
// installer's natural `kubectl wait --for=condition=Available` sufficient.
//
// webhookEnabled MUST mirror the webhook-registration condition in main():
// mgr.GetWebhookServer() registers the server as a manager runnable, so
// calling it on a cert-less local run (`make run`) would make the manager try
// — and fail — to serve TLS.
func setupHealthChecks(mgr ctrl.Manager, webhookEnabled bool) error {
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		return fmt.Errorf("failed to set up health check: %w", err)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		return fmt.Errorf("failed to set up ready check: %w", err)
	}
	if webhookEnabled {
		if err := mgr.AddReadyzCheck("webhook-started", mgr.GetWebhookServer().StartedChecker()); err != nil {
			return fmt.Errorf("failed to set up webhook ready check: %w", err)
		}
	}
	return nil
}
