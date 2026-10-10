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

package v1alpha1

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	admissionv1 "k8s.io/api/admission/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// This suite installs the NextApp validating webhook into an envtest API server
// and asserts that the API server itself rejects invalid NextApp writes at
// admission time (acceptance criteria for issue #77).

var (
	cancel    context.CancelFunc
	testEnv   *envtest.Environment
	cfg       *rest.Config
	k8sClient client.Client
)

func TestWebhook(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Webhook Suite")
}

var _ = BeforeSuite(func() {
	logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

	var ctx context.Context
	ctx, cancel = context.WithCancel(context.TODO())

	Expect(appsv1alpha1.AddToScheme(scheme.Scheme)).To(Succeed())
	Expect(platformv1alpha1.AddToScheme(scheme.Scheme)).To(Succeed())
	Expect(admissionv1.AddToScheme(scheme.Scheme)).To(Succeed())

	By("bootstrapping test environment with the validating webhook")
	testEnv = &envtest.Environment{
		CRDDirectoryPaths:     []string{filepath.Join("..", "..", "..", "config", "crd", "bases")},
		ErrorIfCRDPathMissing: true,
		WebhookInstallOptions: envtest.WebhookInstallOptions{
			Paths: []string{filepath.Join("..", "..", "..", "config", "webhook")},
		},
	}
	if dir := firstEnvTestBinaryDir(); dir != "" {
		testEnv.BinaryAssetsDirectory = dir
	}

	var err error
	cfg, err = testEnv.Start()
	Expect(err).NotTo(HaveOccurred())
	Expect(cfg).NotTo(BeNil())

	k8sClient, err = client.New(cfg, client.Options{Scheme: scheme.Scheme})
	Expect(err).NotTo(HaveOccurred())

	By("starting the webhook manager")
	webhookOpts := testEnv.WebhookInstallOptions
	mgr, err := manager.New(cfg, manager.Options{
		Scheme:  scheme.Scheme,
		Metrics: metricsserver.Options{BindAddress: "0"},
		WebhookServer: webhook.NewServer(webhook.Options{
			Host:    webhookOpts.LocalServingHost,
			Port:    webhookOpts.LocalServingPort,
			CertDir: webhookOpts.LocalServingCertDir,
		}),
	})
	Expect(err).NotTo(HaveOccurred())

	Expect(SetupNextAppWebhookWithManager(mgr)).To(Succeed())

	go func() {
		defer GinkgoRecover()
		Expect(mgr.Start(ctx)).To(Succeed())
	}()

	// Wait for the webhook server's TLS endpoint to come up.
	dialAddr := fmt.Sprintf("%s:%d", webhookOpts.LocalServingHost, webhookOpts.LocalServingPort)
	Eventually(func() error {
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", dialAddr,
			&tls.Config{InsecureSkipVerify: true}) // #nosec G402 -- test-only self-signed cert
		if err != nil {
			return err
		}
		return conn.Close()
	}, 10*time.Second, 200*time.Millisecond).Should(Succeed())
})

var _ = AfterSuite(func() {
	if cancel != nil {
		cancel()
	}
	if testEnv != nil {
		Expect(testEnv.Stop()).To(Succeed())
	}
})

var _ = Describe("NextApp validating webhook (envtest)", func() {
	const ns = "default"

	mkApp := func(name string, spec appsv1alpha1.NextAppSpec) *appsv1alpha1.NextApp {
		return &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
			Spec:       spec,
		}
	}

	It("rejects a :latest image at admission", func() {
		err := k8sClient.Create(context.Background(),
			mkApp("latest-img", appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:latest"}))
		Expect(err).To(HaveOccurred())
		Expect(strings.ToLower(err.Error())).To(ContainSubstring("latest"))
	})

	It("rejects a tag-only image at admission", func() {
		err := k8sClient.Create(context.Background(),
			mkApp("tag-only", appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:v1.2.3"}))
		Expect(err).To(HaveOccurred())
	})

	It("rejects minScale > maxScale at admission", func() {
		err := k8sClient.Create(context.Background(),
			mkApp("bad-scale", appsv1alpha1.NextAppSpec{
				Image:   "registry.example.com/app@sha256:abc123",
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 5, MaxScale: 1},
			}))
		Expect(err).To(HaveOccurred())
		Expect(strings.ToLower(err.Error())).To(ContainSubstring("minscale"))
	})

	It("admits a valid digest-pinned NextApp", func() {
		err := k8sClient.Create(context.Background(),
			mkApp("valid-app", appsv1alpha1.NextAppSpec{
				Image:   "registry.example.com/app:v1@sha256:abc123def456",
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 1, MaxScale: 10},
			}))
		Expect(err).NotTo(HaveOccurred())
	})
})

func firstEnvTestBinaryDir() string {
	base := filepath.Join("..", "..", "..", "bin", "k8s")
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
