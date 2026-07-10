//go:build e2e_cli
// +build e2e_cli

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

// Package e2e — the CLI end-to-end suite (build tag `e2e_cli`).
//
// WHAT THIS PROVES (distinct from install_bundle_test.go):
//
//	The kn-next CLI's cluster-facing commands (`doctor`, `db bind`, `status`)
//	are unit-tested hermetically behind an injectable kubectl runner — until
//	this suite, NOTHING exercised them against a real apiserver. This suite
//	runs the REAL, built CLI (plain `node packages/kn-next/dist/cli/kn-next.js`,
//	no Bun) against a live Kubernetes + Knative + operator cluster and asserts:
//
//	  a. `kn-next doctor --json` exits 0 on a correctly provisioned cluster and
//	     each check reports the REAL state (CRD present, operator Ready,
//	     Knative Serving installed; the #208 ingress-class check either passes
//	     or reports honestly; the #198 image probe reports honestly for the
//	     operator image actually installed).
//	  b. `kn-next db bind <app> --secret <name> --key <k>` performs its single
//	     ADR-0001-compliant write — ONE `kubectl patch nextapp --type merge`
//	     setting spec.database.secretRef — against the LIVE CRD schema, and its
//	     post-patch verify-read (the pre-#222 silent-prune guard) passes because
//	     the real CRD serves the field. The operator then reconciles the BYO
//	     binding to DatabaseReady=True/Bound (ADR-0019).
//	  c. `kn-next status <app>` renders the operator's honest conditions and
//	     honors the exit-code contract: exit 1 iff Ready=False. With the
//	     deliberately-unpullable placeholder app image the CR honestly reaches
//	     Ready=False/KnativeServiceNotReady, so status must exit 1 and say so.
//
// TWO PROVISIONING MODES (KNEXT_E2E_KUBE_CONTEXT):
//
//	Default (unset) — self-contained kind mode, what CI runs: the suite builds
//	the operator image locally, kind-loads it, applies dist/install.yaml with
//	the manager image overridden, and tears the bundle down afterwards. The
//	local image's registry host is the RFC-2606-reserved `.invalid` TLD, which
//	can never resolve, pinning doctor's #198 probe to its honest
//	"registry unreachable → SKIP" path.
//
//	KNEXT_E2E_KUBE_CONTEXT=<context> — existing-cluster mode (e.g. a live OKE
//	cluster): the suite renders a minified kubeconfig for THAT context, exports
//	it to every subprocess (the Go harness AND the CLI under test), and runs
//	READ-ONLY against the cluster's ALREADY-INSTALLED operator — it never
//	builds, installs, upgrades, or deletes the operator, never touches Knative
//	or ingress config, and confines every write to one fresh, randomly-named
//	namespace that it fully deletes afterwards. If the installed operator
//	predates the spec.database.secretRef schema (#222), the db-bind
//	verify-read catching silent pruning is a legitimate honest outcome — the
//	spec fails loudly and the finding is reported, not hidden.
//
// WHY A SEPARATE BUILD TAG (`e2e_cli`):
//
//	Same reason as e2e_bundle: this needs cert-manager + Knative Serving +
//	Kourier (heavier than the light per-PR e2e) PLUS a Node + pnpm toolchain to
//	build the CLI. It declares its OWN suite runner so it never collides with
//	the `e2e || e2e_scale` BeforeSuite in e2e_suite_test.go. It runs in the
//	nightly workflow (operator-e2e-nightly.yml, job `cli-e2e`) as an
//	INDEPENDENT job so a scale-suite flake never blocks it.
package e2e

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

const (
	// cliOperatorImage is the LOCALLY-built operator image for kind mode. It is
	// loaded straight into kind and substituted into dist/install.yaml. The
	// `.invalid` registry host is RFC-2606-reserved to never resolve — see the
	// package comment for why that matters to doctor's image probe.
	cliOperatorImage = "registry.invalid/kn-next-operator:cli-e2e"

	cliOperatorNamespace = "kn-next-operator-system"
	cliOperatorDeploy    = "kn-next-operator-controller-manager"

	cliAppName = "cli-e2e-app"

	// cliDBSecretName / cliDBSecretKey — the BYO Postgres Secret `db bind` binds
	// (ADR-0019). The DSN is an inert placeholder pointing at a host inside the
	// suite's own throwaway namespace: nothing ever dials it, and it is NOT a
	// CNPG service of any existing zone (data-sovereignty rule).
	cliDBSecretName = "cli-e2e-db"
	cliDBSecretKey  = "DATABASE_URL"

	// cliAppImage is digest-pinned (so it passes the operator's :latest
	// rejection) but a DELIBERATELY UNPULLABLE all-zeros placeholder — the same
	// pattern as the bundle suite. The ksvc can therefore never become Ready,
	// which is exactly what the `status` spec needs: an HONEST
	// Ready=False/KnativeServiceNotReady for the exit-1 contract. It also means
	// NO app workload ever actually runs, keeping the existing-cluster mode
	// harmless to a shared cluster.
	cliAppImage = "ghcr.io/getknext-dev/file-manager@sha256:" +
		"0000000000000000000000000000000000000000000000000000000000000000"
)

// cliAppNamespace is fresh and randomly-suffixed per run: mandatory hygiene for
// existing-cluster mode (a live shared cluster must only ever see writes inside
// this one namespace), harmless on a throwaway kind cluster.
// KNEXT_E2E_NAMESPACE overrides it — every setup write is idempotent, so a
// re-run can point at a previous run's namespace (e.g. to let the suite's own
// confirmed teardown reclaim a namespace an aborted run left behind).
var cliAppNamespace = func() string {
	if v := strings.TrimSpace(os.Getenv("KNEXT_E2E_NAMESPACE")); v != "" {
		return v
	}
	return fmt.Sprintf("e2e-cli-%x", time.Now().UnixNano()&0xffffff)
}()

// cliExistingContext selects existing-cluster mode when non-empty.
func cliExistingContext() string {
	return strings.TrimSpace(os.Getenv("KNEXT_E2E_KUBE_CONTEXT"))
}

// TestCLIE2E runs the CLI e2e suite. Own runner — the e2e/e2e_scale runner in
// e2e_suite_test.go and the bundle runner are excluded by the build tag.
func TestCLIE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter, "Starting kn-next CLI e2e suite (doctor / db bind / status)\n")
	RunSpecs(t, "cli e2e suite")
}

// ---------------------------------------------------------------------------
// CLI process harness
// ---------------------------------------------------------------------------

// repoRoot returns the monorepo root (two levels above the operator package,
// which is what utils.GetProjectDir resolves).
func repoRoot() string {
	dir, err := utils.GetProjectDir()
	Expect(err).NotTo(HaveOccurred())
	return filepath.Clean(filepath.Join(dir, "..", ".."))
}

// cliBin is the built CLI entry — the SAME file package.json's bin maps to.
// Invoked with plain `node`: the CLI must not require Bun (#68).
func cliBin() string {
	return filepath.Join(repoRoot(), "packages", "kn-next", "dist", "cli", "kn-next.js")
}

// cliResult carries everything a spec asserts about one CLI invocation.
type cliResult struct {
	stdout   string
	stderr   string
	exitCode int
}

// runCLI invokes the REAL built CLI with plain node from the repo root.
// A non-zero exit is NOT an error here — the exit code is part of the CLI's
// contract and the specs assert it explicitly.
func runCLI(args ...string) cliResult {
	cmd := exec.Command("node", append([]string{cliBin()}, args...)...)
	cmd.Dir = repoRoot()
	// NODE_OPTIONS is cleared deliberately: the CLI must run on a bare Node,
	// and an inherited preload (dev machines) must not skew the e2e. KUBECONFIG
	// (set by the suite in existing-cluster mode) is inherited via os.Environ.
	cmd.Env = append(os.Environ(), "NODE_OPTIONS=")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	_, _ = fmt.Fprintf(GinkgoWriter, "running CLI: node %s %s\n", cliBin(), strings.Join(args, " "))
	err := cmd.Run()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			Expect(err).NotTo(HaveOccurred(),
				"failed to spawn the CLI at all (is node installed and the CLI built?)")
		}
	}
	_, _ = fmt.Fprintf(GinkgoWriter, "CLI exit=%d\nstdout:\n%s\nstderr:\n%s\n",
		code, stdout.String(), stderr.String())
	return cliResult{stdout: stdout.String(), stderr: stderr.String(), exitCode: code}
}

// cliAssertTimeout / cliAssertPoll bound the Eventually blocks that wrap each
// CLI invocation + its assertions. RETRIED AS A WHOLE, deliberately: the specs
// assert the CLI's verdict on a HEALTHY, OBSERVABLE cluster, and against a
// remote cluster a single dropped connection inside one attempt (observed live
// against OKE: intermittent TLS handshake timeouts, one-off exec-credential
// hiccups) yields an honest-but-unlucky report that is NOT a counterexample of
// that property. A DETERMINISTIC misbehavior keeps failing every attempt and
// surfaces as the Eventually's final, real failure — nothing is weakened, and
// on a local/CI kind cluster every block passes on its first attempt.
//
// The budget is sized for doctor's worst case on a LOSSY remote link: one
// doctor attempt makes ~10 sequential kubectl calls (each exec'ing the cloud
// credential plugin) and needs ALL of them to connect; measured live against
// OKE at a 10–30%% per-call drop rate, a fully-connected attempt can take
// several tries.
const (
	cliAssertTimeout = 8 * time.Minute
	cliAssertPoll    = 5 * time.Second
)

// kubectlEventuallyCreates runs an idempotent kubectl create-style command,
// retrying transient failures (WAN blips against a remote cluster) and treating
// "already exists" as success — the retry after a half-committed create must
// not fail the suite.
func kubectlEventuallyCreates(desc string, args ...string) {
	Eventually(func(g Gomega) {
		out, err := utils.Kubectl(args...)
		if err != nil && strings.Contains(out, "already exists") {
			return
		}
		g.Expect(err).NotTo(HaveOccurred(), out)
	}, 2*time.Minute, 10*time.Second).Should(Succeed(), "failed to %s", desc)
}

// runAtRepoRoot runs a toolchain command (pnpm) from the monorepo root.
// utils.Run cannot be used here: it force-overrides cmd.Dir to the operator dir.
func runAtRepoRoot(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = repoRoot()
	cmd.Env = append(os.Environ(), "NODE_OPTIONS=")
	_, _ = fmt.Fprintf(GinkgoWriter, "running (repo root): %s %s\n", name, strings.Join(args, " "))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s failed: %w\n%s", name, strings.Join(args, " "), err, out)
	}
	return string(out), nil
}

// pinKubeContext renders a minified, self-contained kubeconfig for the given
// context and exports KUBECONFIG so EVERY subprocess (the Go harness's kubectl
// AND the CLI under test) targets exactly that cluster — without ever touching
// the user's global current-context. Credential exec plugins (e.g. OCI's
// security_token auth) keep working because --raw preserves the users section
// and env vars like OCI_CLI_PROFILE/OCI_CLI_AUTH pass through os.Environ.
func pinKubeContext(ctx string) {
	out, err := utils.Run(exec.Command("kubectl", "config", "view",
		"--minify", "--raw", "--flatten", fmt.Sprintf("--context=%s", ctx), "-o", "yaml"))
	Expect(err).NotTo(HaveOccurred(), "failed to render a kubeconfig for context %q", ctx)

	dir := GinkgoT().TempDir()
	path := filepath.Join(dir, "kubeconfig")
	Expect(os.WriteFile(path, []byte(out), 0o600)).To(Succeed())
	Expect(os.Setenv("KUBECONFIG", path)).To(Succeed())
	_, _ = fmt.Fprintf(GinkgoWriter, "pinned KUBECONFIG for context %q at %s\n", ctx, path)
}

// extractJSON pulls the outermost JSON object out of a stdout that may carry
// stray non-JSON lines around it (defensive; the CLI writes clean JSON today).
// Gomega-parameterized so it composes with the retried Eventually blocks.
func extractJSON(g Gomega, s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	g.Expect(start).To(BeNumerically(">=", 0), "no JSON object found in CLI stdout:\n%s", s)
	g.Expect(end).To(BeNumerically(">", start), "unterminated JSON object in CLI stdout:\n%s", s)
	return s[start : end+1]
}

// ---------------------------------------------------------------------------
// JSON contracts the specs assert (mirrors of the CLI's --json shapes)
// ---------------------------------------------------------------------------

type doctorCheck struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type doctorReport struct {
	Checks   []doctorCheck `json:"checks"`
	ExitCode int           `json:"exitCode"`
}

type statusCondition struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

type statusReport struct {
	Name          string           `json:"name"`
	Namespace     string           `json:"namespace"`
	URL           *string          `json:"url"`
	Ready         *statusCondition `json:"ready"`
	DatabaseReady *statusCondition `json:"databaseReady"`
	Database      struct {
		Mode       string `json:"mode"`
		SecretName string `json:"secretName"`
	} `json:"database"`
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

var _ = Describe("kn-next CLI against a live cluster", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	var renderedBundle string
	existing := cliExistingContext()

	BeforeAll(func() {
		By("building the CLI from source with pnpm (plain-Node dist, no Bun)")
		// Requires `pnpm install` to have run at the repo root (CI does; see the
		// Makefile target's doc). tsup emits dist/cli/kn-next.js — the bin entry.
		// The `...` filter suffix builds @knext/core's WORKSPACE DEPENDENCIES
		// first (@knext/lib ships only dist/, and core's dts build imports
		// @knext/lib/clients — on a clean checkout the bare filter fails TS2307).
		_, err := runAtRepoRoot("pnpm", "--filter", "@knext/core...", "build")
		Expect(err).NotTo(HaveOccurred(),
			"failed to build the CLI — run `pnpm install --frozen-lockfile` at the repo root first")
		Expect(cliBin()).To(BeAnExistingFile(), "CLI build produced no dist/cli/kn-next.js")

		if existing != "" {
			By(fmt.Sprintf("EXISTING-CLUSTER mode: pinning kube context %q (no operator install)", existing))
			pinKubeContext(existing)
		} else {
			By("building the operator image LOCALLY (never a published image)")
			_, err = utils.Run(exec.Command("make", "docker-build",
				fmt.Sprintf("IMG=%s", cliOperatorImage)))
			Expect(err).NotTo(HaveOccurred(), "failed to build the operator image")

			By("loading the locally-built operator image into kind")
			Expect(utils.LoadImageToKindClusterWithName(cliOperatorImage)).
				To(Succeed(), "failed to load operator image into kind")

			By("rendering the install bundle via make build-installer")
			_, err = utils.Run(exec.Command("make", "build-installer"))
			Expect(err).NotTo(HaveOccurred(), "failed to render dist/install.yaml")

			By("overriding the manager image in the rendered bundle to the local image")
			renderedBundle = cliOverrideManagerImage(cliOperatorImage)

			By("applying the rendered install bundle (kubectl apply --server-side -f)")
			Expect(cliApplyOrDeleteBundle("apply", renderedBundle)).
				To(Succeed(), "failed to kubectl apply the install bundle")
		}

		By("waiting for the operator Deployment to be Available (read-only check in existing mode)")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "deployment", cliOperatorDeploy,
				"-n", cliOperatorNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Available')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(out).To(Equal("True"), "operator Deployment not Available")
		}).Should(Succeed())

		// The one-shot setup writes below are Eventually-wrapped: against a
		// REMOTE existing cluster a single TLS-handshake blip must retry, not
		// abort the suite (observed live against OKE). Each call is idempotent
		// under retry ("already exists" after a half-committed create = done).
		By(fmt.Sprintf("creating the fresh, dedicated app namespace %q", cliAppNamespace))
		kubectlEventuallyCreates("create the app namespace",
			"create", "ns", cliAppNamespace)

		By("creating the BYO Postgres Secret (DATABASE_URL key) — ADR-0019 binding target")
		// The DSN is inert (never dialed) and names a host in the suite's OWN
		// throwaway namespace — deliberately not any existing zone's database.
		kubectlEventuallyCreates("create the DATABASE_URL Secret",
			"create", "secret", "generic", cliDBSecretName,
			"-n", cliAppNamespace,
			fmt.Sprintf("--from-literal=%s=postgres://app:app@byo-postgres.%s.svc.cluster.local:5432/app?sslmode=require",
				cliDBSecretKey, cliAppNamespace))

		By("applying a DIGEST-PINNED NextApp (unpullable placeholder image)")
		Eventually(func(g Gomega) {
			g.Expect(cliApplyManifest(cliSampleNextApp())).To(Succeed(), "failed to apply NextApp")
		}, 2*time.Minute, 10*time.Second).Should(Succeed())

		By("waiting for the operator to create the child Knative Service (reconcile proof)")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "ksvc", cliAppName, "-n", cliAppNamespace,
				"-o", "jsonpath={.metadata.name}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).To(Equal(cliAppName))
		}).Should(Succeed())

		By("waiting for status.url to be mirrored from the ksvc")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", cliAppName, "-n", cliAppNamespace,
				"-o", "jsonpath={.status.url}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).NotTo(BeEmpty(), "NextApp status.url is empty")
		}).Should(Succeed())
	})

	AfterAll(func() {
		By(fmt.Sprintf("deleting the dedicated app namespace %q (full cleanup)", cliAppNamespace))
		// Deletion is WAITED ON (bounded) deliberately, and must complete BEFORE
		// the bundle delete below: tearing down the bundle removes the operator's
		// webhook + the NextApp CRD, and a NextApp CR still finalizing in a
		// terminating namespace then deadlocks the CRD's instance-cleanup
		// finalizer — kubectl blocks until the go-test timeout. (Observed live:
		// a --wait=false here hung the first local run's AfterAll for 25m.)
		// Existing-cluster mode needs the full wait anyway: leave NOTHING behind.
		// Eventually-wrapped with a confirmed-NotFound read so a WAN blip can
		// never fake a completed cleanup on a shared cluster.
		Eventually(func(g Gomega) {
			_, _ = utils.Kubectl("delete", "ns", cliAppNamespace, "--ignore-not-found", "--timeout=5m")
			out, err := utils.Kubectl("get", "ns", cliAppNamespace)
			g.Expect(err).To(HaveOccurred(), "namespace still exists:\n%s", out)
			g.Expect(out).To(ContainSubstring("NotFound"),
				"namespace deletion not confirmed (transient error, not NotFound):\n%s", out)
		}, 10*time.Minute, 5*time.Second).Should(Succeed(),
			"failed to fully delete the dedicated namespace %s", cliAppNamespace)

		if existing == "" {
			By("deleting the rendered bundle from the cluster")
			_ = cliApplyOrDeleteBundle("delete", renderedBundle)
			if renderedBundle != "" {
				_ = os.Remove(renderedBundle)
			}
		}
	})

	It("kn-next doctor: exit 0 on a provisioned cluster, every check honest", func() {
		Eventually(func(g Gomega) {
			res := runCLI("doctor", "--json")
			g.Expect(res.exitCode).To(Equal(0),
				"doctor must exit 0 on a correctly provisioned cluster\nstdout:\n%s\nstderr:\n%s",
				res.stdout, res.stderr)

			var report doctorReport
			g.Expect(json.Unmarshal([]byte(extractJSON(g, res.stdout)), &report)).To(Succeed(),
				"doctor --json stdout is not parseable JSON:\n%s", res.stdout)
			g.Expect(report.ExitCode).To(Equal(0), "report.exitCode must match the process exit code")

			byID := map[string]doctorCheck{}
			for _, c := range report.Checks {
				byID[c.ID] = c
			}

			// Hard truths about THIS cluster: reachable, CRD served, operator Ready,
			// Knative Serving installed. These must be PASS, not merely non-fail.
			for _, id := range []string{"cluster", "crd", "operator", "knative"} {
				c, ok := byID[id]
				g.Expect(ok).To(BeTrue(), "doctor report missing check %q:\n%s", id, res.stdout)
				g.Expect(c.Status).To(Equal("pass"), "check %q should PASS on this cluster: %s", id, c.Detail)
			}

			// #208 ingress-class: the CI harness patches config-network to the class
			// net-kourier serves, so a healthy run PASSes. WARN is tolerated only as
			// an HONEST report (e.g. a reused/shared cluster with a different
			// networking layer) — FAIL is not.
			ingress, ok := byID["ingress"]
			g.Expect(ok).To(BeTrue(), "doctor report missing the ingress check")
			g.Expect(ingress.Status).To(BeElementOf("pass", "warn"),
				"ingress-class check must not FAIL on a Knative cluster: %s", ingress.Detail)

			// #198 image probe:
			//  - kind mode: the operator image registry is a reserved-`.invalid` host
			//    that can never resolve, so the ONLY honest outcome is the
			//    offline-degradation SKIP. Anything else means the probe fabricated a
			//    result for an unreachable registry.
			//  - existing-cluster mode: the installed operator image is whatever the
			//    cluster runs; pass/warn/skip are all honest depending on registry
			//    visibility — a FAIL ("not-found") is a real finding and must surface.
			image, ok := byID["image"]
			g.Expect(ok).To(BeTrue(), "doctor report missing the image check")
			if existing == "" {
				g.Expect(image.Status).To(Equal("skip"),
					"image probe must honestly SKIP for an unresolvable registry host: %s", image.Detail)
			} else {
				g.Expect(image.Status).NotTo(Equal("fail"),
					"image probe FAILed against the installed operator image: %s", image.Detail)
			}
		}, cliAssertTimeout, cliAssertPoll).Should(Succeed())

		By("kn-next doctor (human): same verdict rendered as the PASS/WARN table")
		Eventually(func(g Gomega) {
			human := runCLI("doctor")
			g.Expect(human.exitCode).To(Equal(0), "doctor (human mode) exit code\nstdout:\n%s\nstderr:\n%s",
				human.stdout, human.stderr)
			g.Expect(human.stdout).To(ContainSubstring("PASS"), "human table should render PASS rows")
		}, cliAssertTimeout, cliAssertPoll).Should(Succeed())
	})

	It("kn-next db bind: patches spec.database.secretRef on the live CR and the verify-read passes", func() {
		// Exit 0 proves the silent-prune guard's verify-read found
		// spec.database.secretRef persisted by the REAL CRD schema — the CLI
		// re-reads the CR after its single merge-patch and throws (exit 1) if
		// structural-schema pruning dropped the field (pre-#222 operators). On an
		// existing cluster whose operator predates #222, this failing loudly is
		// the honest, intended outcome. The bind is a merge-patch of constant
		// content, so retrying across WAN blips is idempotent.
		Eventually(func(g Gomega) {
			res := runCLI("db", "bind", cliAppName,
				"--secret", cliDBSecretName,
				"--key", cliDBSecretKey,
				"-n", cliAppNamespace)
			g.Expect(res.exitCode).To(Equal(0),
				"db bind must exit 0 (patch + verify-read). A persistent failure here "+
					"on an existing cluster can mean the installed operator predates the "+
					"spec.database.secretRef schema (#222) — an honest finding.\nstdout:\n%s\nstderr:\n%s",
				res.stdout, res.stderr)
		}, cliAssertTimeout, cliAssertPoll).Should(Succeed())

		By("asserting the LIVE CR carries spec.database.secretRef (kubectl get -o json)")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", cliAppName, "-n", cliAppNamespace, "-o", "json")
			g.Expect(err).NotTo(HaveOccurred(), out)
			var cr struct {
				Spec struct {
					Database struct {
						Enabled   *bool `json:"enabled"`
						SecretRef *struct {
							Name string `json:"name"`
							Key  string `json:"key"`
						} `json:"secretRef"`
					} `json:"database"`
				} `json:"spec"`
			}
			g.Expect(json.Unmarshal([]byte(out), &cr)).To(Succeed(), "unparseable NextApp JSON:\n%s", out)
			g.Expect(cr.Spec.Database.SecretRef).NotTo(BeNil(),
				"spec.database.secretRef missing on the live CR — the merge-patch did not bind")
			g.Expect(cr.Spec.Database.SecretRef.Name).To(Equal(cliDBSecretName))
			g.Expect(cr.Spec.Database.SecretRef.Key).To(Equal(cliDBSecretKey))
			// ADR-0019 rule 5: BYO binding must not have flipped managed mode on.
			g.Expect(cr.Spec.Database.Enabled).To(Or(BeNil(), HaveValue(BeFalse())),
				"db bind must never enable managed mode")
		}, cliAssertTimeout, cliAssertPoll).Should(Succeed())

		By("waiting for the operator to reconcile the binding to DatabaseReady=True/Bound (ADR-0019)")
		Eventually(func(g Gomega) {
			status, err := utils.Kubectl("get", "nextapp", cliAppName, "-n", cliAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='DatabaseReady')].status}")
			g.Expect(err).NotTo(HaveOccurred(), status)
			g.Expect(strings.TrimSpace(status)).To(Equal("True"))
			reason, err := utils.Kubectl("get", "nextapp", cliAppName, "-n", cliAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='DatabaseReady')].reason}")
			g.Expect(err).NotTo(HaveOccurred(), reason)
			g.Expect(strings.TrimSpace(reason)).To(Equal("Bound"))
		}).Should(Succeed())
	})

	It("kn-next status: renders the live honest conditions and exits 1 iff Ready=False", func() {
		By("waiting for the CR to reach its honest Ready=False (unpullable placeholder image)")
		// Same honest-NotReady semantics the bundle suite proves: the all-zeros
		// digest can never pull, the ksvc can never become Ready, and the
		// operator reports Ready=False/KnativeServiceNotReady — the truth the
		// CLI must now surface verbatim.
		Eventually(func(g Gomega) {
			status, err := utils.Kubectl("get", "nextapp", cliAppName, "-n", cliAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred(), status)
			g.Expect(strings.TrimSpace(status)).To(Equal("False"))
		}).Should(Succeed())

		By("kn-next status --json: exit 1 + the operator's conditions verbatim")
		Eventually(func(g Gomega) {
			res := runCLI("status", cliAppName, "-n", cliAppNamespace, "--json")
			g.Expect(res.exitCode).To(Equal(1),
				"status must exit 1 when Ready=False (the CI-gate contract)\nstdout:\n%s\nstderr:\n%s",
				res.stdout, res.stderr)

			var report statusReport
			g.Expect(json.Unmarshal([]byte(extractJSON(g, res.stdout)), &report)).To(Succeed(),
				"status --json stdout is not parseable JSON:\n%s", res.stdout)
			g.Expect(report.Name).To(Equal(cliAppName))
			g.Expect(report.Namespace).To(Equal(cliAppNamespace))
			g.Expect(report.URL).NotTo(BeNil(), "status must surface the mirrored status.url")
			g.Expect(*report.URL).NotTo(BeEmpty())
			g.Expect(report.Ready).NotTo(BeNil(), "status must surface the Ready condition")
			g.Expect(report.Ready.Status).To(Equal("False"))
			g.Expect(report.Ready.Reason).To(Equal("KnativeServiceNotReady"),
				"status must relay the operator's honest reason, not a synthesized one")
			// The spec above bound the BYO Secret — status reports the database truth.
			g.Expect(report.Database.Mode).To(Equal("bound"))
			g.Expect(report.Database.SecretName).To(Equal(cliDBSecretName))
			g.Expect(report.DatabaseReady).NotTo(BeNil())
			g.Expect(report.DatabaseReady.Status).To(Equal("True"))
			g.Expect(report.DatabaseReady.Reason).To(Equal("Bound"))
		}, cliAssertTimeout, cliAssertPoll).Should(Succeed())

		By("kn-next status (human): same exit code, honest reason in the rendering")
		Eventually(func(g Gomega) {
			human := runCLI("status", cliAppName, "-n", cliAppNamespace)
			g.Expect(human.exitCode).To(Equal(1), "human mode must honor the same exit-code contract")
			g.Expect(human.stdout).To(ContainSubstring("KnativeServiceNotReady"),
				"the human rendering must carry the operator's honest Ready reason:\n%s", human.stdout)
		}, cliAssertTimeout, cliAssertPoll).Should(Succeed())
	})
})

// ---------------------------------------------------------------------------
// Bundle-install helpers (e2e_cli-tagged copies — the bundle suite's versions
// live behind e2e_bundle and cross-tag symbol sharing is deliberately avoided,
// same as applyBundleManifest's precedent).
// ---------------------------------------------------------------------------

// cliOverrideManagerImage renders a copy of dist/install.yaml with the operator
// manager image line rewritten to `img`, returning the rewritten bundle's path.
func cliOverrideManagerImage(img string) string {
	src, err := os.ReadFile(filepath.Join("dist", "install.yaml"))
	Expect(err).NotTo(HaveOccurred(), "failed to read rendered dist/install.yaml")

	var b strings.Builder
	replaced := false
	for _, line := range strings.Split(string(src), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "image:") &&
			strings.Contains(line, "ghcr.io/getknext-dev/kn-next-operator") {
			indent := line[:strings.Index(line, "image:")]
			b.WriteString(indent + "image: " + img + "\n")
			replaced = true
			continue
		}
		b.WriteString(line + "\n")
	}
	Expect(replaced).To(BeTrue(),
		"did not find the operator manager image line in dist/install.yaml")

	dst := filepath.Join("dist", "install.cli-e2e.yaml")
	Expect(os.WriteFile(dst, []byte(b.String()), 0o644)).To(Succeed())
	return dst
}

// cliApplyOrDeleteBundle runs `kubectl <apply|delete> --server-side -f <bundle>`.
func cliApplyOrDeleteBundle(verb, bundle string) error {
	if bundle == "" {
		return nil
	}
	args := []string{verb}
	if verb == "apply" {
		args = append(args, "--server-side")
	} else {
		args = append(args, "--ignore-not-found")
	}
	args = append(args, "-f", bundle)
	cmd := exec.Command("kubectl", args...)
	_, err := utils.Run(cmd)
	return err
}

// cliApplyManifest pipes a YAML manifest into `kubectl apply -f -`.
func cliApplyManifest(manifest string) error {
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(manifest)
	_, err := utils.Run(cmd)
	return err
}

// cliSampleNextApp renders the minimal, DIGEST-PINNED NextApp CR under test.
func cliSampleNextApp() string {
	return fmt.Sprintf(`apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: %s
  namespace: %s
spec:
  image: %q
  scaling:
    minScale: 0
    maxScale: 1
`, cliAppName, cliAppNamespace, cliAppImage)
}
