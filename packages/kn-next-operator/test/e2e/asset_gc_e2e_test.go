//go:build e2e_gc
// +build e2e_gc

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

// Package e2e — the ASSET-GC / skew-protection end-to-end suite (build tag
// `e2e_gc`, plan item P4).
//
// WHAT THIS PROVES (the ADR-0011 live-set guarantee, live):
//
//	"Never reap a pinned/live revision's assets" was only unit-tested (the
//	pure selector in asset-gc.test.ts, the prune argv in asset-prune.test.ts).
//	The REAL wiring — NextApp status.currentTraffic → resolve each live
//	revision's `apps.kn-next.dev/build-id` label → live set, with the
//	fail-safe over-keep skip — had ZERO live coverage. A GC bug here deletes
//	user data; this suite is its safety net.
//
// THE VERIFIED LABEL-STAMPING CHAIN (pre-verified in code, plan gate):
//
//  1. `kn-next deploy` writes the deploy tag as NextApp `spec.buildId`
//     (deploy.ts → renderNextAppCR).
//
//  2. The operator stamps `apps.kn-next.dev/build-id: <spec.buildId>` onto
//     the ksvc's revision (pod) TEMPLATE labels (nextapp_controller.go,
//     "Skew protection (#93)"); Knative propagates template labels to every
//     Revision.
//
//  3. The GC resolves each revision in status.currentTraffic back to its
//     build-id via that label, READ-ONLY (gc.ts runAssetGC — the exact code
//     deploy.ts runs post-deploy).
//
//     This suite drives steps 2–3 for real: `spec.buildId` on the CR (standing
//     in for the deploy that would set it), the operator's stamping asserted on
//     the live Revision object, and the REAL built CLI's `kn-next gc` (the same
//     runAssetGC wiring `kn-next deploy` calls) doing the resolution + prune.
//
// GC-DRIVE MECHANISM: deploy.ts's GC only runs at the tail of a full
// build→push→apply deploy (unreachable without a docker registry + a real
// Next build). The GC block was therefore extracted VERBATIM into
// `runAssetGC` (packages/kn-next/src/cli/gc.ts), called by BOTH deploy.ts and
// the new `kn-next gc` subcommand — so this suite drives the identical
// wiring through the real CLI binary, with no mock seam.
//
// WHAT SEEDING DOES — AND DOES NOT — PROVE: the object-store state is seeded
// via the S3 API in the EXACT ADR-0008/ADR-0011 layout the pruner operates
// on (`<app>/_next/static/<build-id>/…` build prefixes, the shared
// non-build-id `chunks/`/`css/`/`media/` dirs real `next build` output also
// places under `_next/static/`, and bare-`<app>/` root keys). Seeding is the
// approved budget shortcut (no 4× `next build` + upload): it does NOT prove
// that a real `next build` + `uploadAssets` produces this shape — that
// contract is covered by asset-upload-standalone.test.ts (staging layout) and
// the deploy-time BUILD_ID lock-step guard in deploy.ts. What this suite DOES
// prove live: the operator's label stamping, the CLI's read-only resolution,
// the retain-window/live-set selection, the fail-safe over-keep skip, and
// that deletes land on exactly the right prefixes of a real S3 store.
//
// ENDPOINT SAFETY (plan gate): before ANY gc invocation the suite asserts the
// S3 endpoint the CLI will use (AWS_ENDPOINT_URL, inherited by the CLI's
// `aws` shell-outs) is the loopback port-forward to THIS suite's in-cluster
// MinIO — proven positively by writing a canary object through the endpoint
// and finding it in the MinIO pod's /data via kubectl exec. A mis-wired
// endpoint deleting from a real bucket is the catastrophic failure mode; the
// suite refuses to run the GC without this proof.
//
// BLAST RADIUS: every cluster write is confined to the throwaway namespace
// (plus, in kind mode, the operator bundle — same contract as the other
// suites); every object-store operation targets the suite's own bucket
// through the loopback endpoint.
//
// WHY A SEPARATE BUILD TAG (`e2e_gc`): same reason as e2e_cli/e2e_rollback —
// needs cert-manager + Knative Serving + Kourier + Node/pnpm + the aws CLI,
// and its OWN suite runner so it never collides with the other suites'
// BeforeSuite hooks. It runs in operator-e2e-nightly.yml as the INDEPENDENT
// `gc-e2e` job — NIGHTLY/DISPATCH ONLY, never PR-gating (plan gate).
package e2e

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
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
	// gcOperatorImage is the LOCALLY-built operator image for kind mode
	// (never a published image), same pattern as the cli/rollback suites.
	gcOperatorImage = "registry.invalid/kn-next-operator:gc-e2e"

	gcOperatorNamespace = "kn-next-operator-system"
	gcOperatorDeploy    = "kn-next-operator-controller-manager"

	// gcAppName doubles as the app-scoped object-store key prefix
	// (`<app>/…`, ADR-0008) — MUST match the `name` in the rendered
	// kn-next.config.ts below.
	gcAppName = "gc-e2e-app"
	gcBucket  = "gc-e2e-assets"

	// gcMinioName is the in-cluster MinIO the suite deploys INSIDE its
	// throwaway namespace. Digest-pinned (multi-arch amd64+arm64:
	// minio/minio:RELEASE.2025-04-22T22-12-26Z), never :latest.
	gcMinioName  = "gc-minio"
	gcMinioImage = "docker.io/minio/minio@sha256:" +
		"a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"

	// gcAppImage is the same REAL, SERVABLE, public, digest-pinned,
	// multi-arch image the rollback suite uses (ghcr.io/knative/helloworld-go)
	// — revisions must genuinely become Ready for status.currentTraffic to be
	// populated. (Fixture-app stretch assessed and SKIPPED — see the plan
	// report: a kn-next-built fixture adds a full Next build + registry to
	// every nightly run and adds no assertion power to the live-set
	// guarantee, which rides on labels + status, not served bytes.)
	gcAppImage = "ghcr.io/knative/helloworld-go@sha256:" +
		"c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba"
)

// The seeded build-ids. Lexicographic order == age order (mirrors real
// numeric deploy tags, which also list oldest-first in an S3 listing):
//   - gcBidUnmarked: the very oldest prefix, seeded WITHOUT the `.knext-build`
//     marker object (#264 marker inversion) — a pre-marker upload / unknown
//     future dir. Out of window, not live: it MUST survive (loud SKIP), the
//     new negative spec.
//   - gcBidPinned: the OLDEST marked build — its revision gets pinned via the
//     real `kn-next rollback --to`, so the live-set rule (NOT the retain
//     window, assetRetention=1) is the only thing protecting it.
//   - gcBidReapA/B: marked, unpinned, out-of-window — MUST be reaped.
//   - gcBidNew: the "just deployed" build (passed as `--build-id`) — kept by
//     the retain window.
const (
	gcBidUnmarked = "bid-00-unmarked"
	gcBidPinned   = "bid-01-pinned"
	gcBidReapA    = "bid-02-reap"
	gcBidReapB    = "bid-03-reap"
	gcBidNew      = "bid-04-new"

	// gcBidCanaryReap is seeded FRESH for the canary-pin leg (#264 part 2):
	// marked, unpinned, out-of-window — the reap that proves the two-target
	// prune actually pruned (the live-set protection is not a no-op).
	gcBidCanaryReap = "bid-05-canary-reap"

	// gcMarkerFile is the ADR-0011 marker object name (#264): the pruner only
	// ever reaps prefixes carrying `<app>/_next/static/<id>/.knext-build`.
	gcMarkerFile = ".knext-build"

	// gcPinnedAppName is the SECOND NextApp of the pin+wiped-status leg
	// (#264 part 2) — its own app-scoped object-store prefix, so the skip
	// proof cannot interfere with the main app's assertions.
	gcPinnedAppName = "gc-e2e-pinned"
)

// The pinned-with-empty-status leg's seeded build-ids: all marked, so with
// assetRetention=1 a window-only prune WOULD reap the two oldest — the skip
// assertion has teeth.
const (
	gcPinnedBidOld1 = "bid-p1"
	gcPinnedBidOld2 = "bid-p2"
	gcPinnedBidNew  = "bid-p3"
)

// gcAppNamespace is fresh and randomly-suffixed per run (same hygiene
// contract as the cli/rollback suites); KNEXT_E2E_NAMESPACE overrides it for
// reclaiming an aborted run's namespace.
var gcAppNamespace = func() string {
	if v := strings.TrimSpace(os.Getenv("KNEXT_E2E_NAMESPACE")); v != "" {
		return v
	}
	return fmt.Sprintf("e2e-gc-%x", time.Now().UnixNano()&0xffffff)
}()

// gcExistingContext selects existing-cluster mode when non-empty.
func gcExistingContext() string {
	return strings.TrimSpace(os.Getenv("KNEXT_E2E_KUBE_CONTEXT"))
}

// TestAssetGCE2E runs the asset-GC e2e suite. Own runner — every other suite
// runner is excluded by the build tag.
func TestAssetGCE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter,
		"Starting kn-next asset-GC e2e suite (ADR-0011 live-set guarantee, plan P4)\n")
	RunSpecs(t, "asset gc e2e suite")
}

const (
	gcAssertTimeout = 8 * time.Minute
	gcAssertPoll    = 5 * time.Second
)

// ---------------------------------------------------------------------------
// S3 helpers (all through AWS_ENDPOINT_URL → the loopback port-forward)
// ---------------------------------------------------------------------------

// gcAWS shells out to the aws CLI — the SAME binary + endpoint config the
// CLI-under-test uses for its s3 provider, so the seeding, the assertions,
// and the GC all see one store.
func gcAWS(args ...string) (string, error) {
	return utils.Run(exec.Command("aws", args...))
}

// gcSeedObject puts one small object at the given key in the suite bucket.
func gcSeedObject(key string) error {
	f, err := os.CreateTemp("", "gc-seed-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(f.Name()) }()
	if _, err := f.WriteString("e2e_gc seed: " + key + "\n"); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	_, err = gcAWS("s3api", "put-object",
		"--bucket", gcBucket, "--key", key, "--body", f.Name())
	return err
}

// gcListKeysUnder returns every key under the given app prefix, as a set.
func gcListKeysUnder(g Gomega, appName string) map[string]bool {
	out, err := gcAWS("s3api", "list-objects-v2",
		"--bucket", gcBucket,
		"--prefix", appName+"/",
		"--query", "Contents[].Key",
		"--output", "text")
	g.Expect(err).NotTo(HaveOccurred(), out)
	keys := map[string]bool{}
	for _, tok := range strings.Fields(out) {
		if tok == "None" || tok == "" {
			continue
		}
		keys[tok] = true
	}
	return keys
}

// gcListAppKeys returns every key under the main app's prefix, as a set.
func gcListAppKeys(g Gomega) map[string]bool {
	return gcListKeysUnder(g, gcAppName)
}

// gcKeysWithPrefix filters a key set down to those under prefix.
func gcKeysWithPrefix(keys map[string]bool, prefix string) []string {
	var got []string
	for k := range keys {
		if strings.HasPrefix(k, prefix) {
			got = append(got, k)
		}
	}
	return got
}

// gcStaticPrefix renders the `<app>/_next/static/<seg>/` object-store prefix.
func gcStaticPrefix(seg string) string {
	return gcAppName + "/_next/static/" + seg + "/"
}

// ---------------------------------------------------------------------------
// Cluster-state helpers
// ---------------------------------------------------------------------------

// gcLatestReadyRevision reads ksvc status.latestReadyRevisionName.
func gcLatestReadyRevision(g Gomega) string {
	out, err := utils.Kubectl("get", "ksvc", gcAppName, "-n", gcAppNamespace,
		"-o", "jsonpath={.status.latestReadyRevisionName}")
	g.Expect(err).NotTo(HaveOccurred(), out)
	return strings.TrimSpace(out)
}

// gcRevisionBuildIDLabel reads a revision's `apps.kn-next.dev/build-id`
// label — the operator-stamped half of the chain under test.
func gcRevisionBuildIDLabel(g Gomega, rev string) string {
	out, err := utils.Kubectl("get", "revision", rev, "-n", gcAppNamespace,
		"-o", `jsonpath={.metadata.labels.apps\.kn-next\.dev/build-id}`)
	g.Expect(err).NotTo(HaveOccurred(), out)
	return strings.TrimSpace(out)
}

// gcCurrentTraffic reads NextApp status.currentTraffic (the operator's
// observed truth the GC resolves against, #92).
func gcCurrentTraffic(g Gomega) []struct {
	RevisionName string `json:"revisionName"`
	Percent      int64  `json:"percent"`
} {
	out, err := utils.Kubectl("get", "nextapp", gcAppName, "-n", gcAppNamespace,
		"-o", "jsonpath={.status.currentTraffic}")
	g.Expect(err).NotTo(HaveOccurred(), out)
	g.Expect(strings.TrimSpace(out)).NotTo(BeEmpty(), "status.currentTraffic is empty")
	var targets []struct {
		RevisionName string `json:"revisionName"`
		Percent      int64  `json:"percent"`
	}
	g.Expect(json.Unmarshal([]byte(out), &targets)).To(Succeed(),
		"unparseable status.currentTraffic: %s", out)
	return targets
}

// gcNextAppManifest renders the NextApp CR under test. TARGET is the
// revision-forcing env lever (#191, same as the rollback suite); buildId is
// the deploy's BUILD_ID the operator stamps as the revision label (#93) —
// empty string omits the field entirely (the fail-safe negative premise).
func gcNextAppManifest(target, buildID string) string {
	buildIDLine := ""
	if buildID != "" {
		buildIDLine = fmt.Sprintf("  buildId: %q\n", buildID)
	}
	return fmt.Sprintf(`apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: %s
  namespace: %s
spec:
  image: %q
  healthCheckPath: /
%s  env:
    TARGET: %q
  scaling:
    minScale: 0
    maxScale: 2
`, gcAppName, gcAppNamespace, gcAppImage, buildIDLine, target)
}

// gcPinnedAppManifest renders the SECOND NextApp of the pin+wiped-status leg
// (#264 part 2): spec.traffic.revisionName set at CREATION, pointing at a
// revision that does not exist. See the spec body for why this is the honest,
// deterministic way to hold "spec pins a revision while status.currentTraffic
// is empty" on a real cluster.
func gcPinnedAppManifest(pinnedRevision string) string {
	return fmt.Sprintf(`apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: %s
  namespace: %s
spec:
  image: %q
  healthCheckPath: /
  env:
    TARGET: "pinned"
  scaling:
    minScale: 0
    maxScale: 2
  traffic:
    revisionName: %q
`, gcPinnedAppName, gcAppNamespace, gcAppImage, pinnedRevision)
}

// gcMinioManifest renders the in-cluster MinIO stack: creds in a K8s Secret
// (never inline in the pod spec — security rule), a single-replica
// Deployment on emptyDir (throwaway data, torn down with the namespace), and
// a ClusterIP Service the suite port-forwards to.
func gcMinioManifest(user, password string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %[1]s-creds
  namespace: %[2]s
type: Opaque
stringData:
  MINIO_ROOT_USER: %[3]q
  MINIO_ROOT_PASSWORD: %[4]q
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: %[1]s
  namespace: %[2]s
spec:
  replicas: 1
  selector:
    matchLabels:
      app: %[1]s
  template:
    metadata:
      labels:
        app: %[1]s
    spec:
      containers:
        - name: minio
          image: %[5]s
          args: ["server", "/data"]
          envFrom:
            - secretRef:
                name: %[1]s-creds
          ports:
            - containerPort: 9000
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: %[1]s
  namespace: %[2]s
spec:
  selector:
    app: %[1]s
  ports:
    - port: 9000
      targetPort: 9000
`, gcMinioName, gcAppNamespace, user, password, gcMinioImage)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

var _ = Describe("asset retention GC against a live cluster (ADR-0011)", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	var (
		renderedBundle string
		appDir         string
		portForward    *exec.Cmd
		endpointURL    string
		localPort      int
		rev1Name       string // no build-id label (fail-safe premise)
		rev2Name       string // labeled gcBidPinned — pinned via rollback
		rev3Name       string // labeled gcBidNew — latest
	)
	existing := gcExistingContext()

	// assertEndpointIsTestMinIO is the MANDATORY pre-delete gate (plan gate 4):
	// it must pass immediately before EVERY gc invocation. (1) the endpoint the
	// CLI inherits is loopback at the suite's forwarded port — a real bucket
	// can never be behind it; (2) positive proof: a canary object written
	// through the endpoint is found in the in-cluster MinIO pod's /data via
	// kubectl exec — the endpoint IS this suite's MinIO, not something else
	// listening on localhost.
	assertEndpointIsTestMinIO := func() {
		By("GATE: asserting the GC's S3 endpoint is the in-cluster test MinIO (refuse to delete otherwise)")
		u, err := url.Parse(os.Getenv("AWS_ENDPOINT_URL"))
		Expect(err).NotTo(HaveOccurred(), "unparseable AWS_ENDPOINT_URL")
		Expect(u.Scheme).To(Equal("http"))
		Expect(u.Hostname()).To(Equal("127.0.0.1"),
			"the GC endpoint MUST be the loopback port-forward, never a real S3 host")
		Expect(u.Port()).To(Equal(fmt.Sprintf("%d", localPort)))

		canaryKey := gcAppName + "/endpoint-canary.txt"
		Expect(gcSeedObject(canaryKey)).To(Succeed(), "failed to write the endpoint canary")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("exec", "-n", gcAppNamespace,
				"deploy/"+gcMinioName, "--",
				"sh", "-c", fmt.Sprintf("find /data/%s -name 'endpoint-canary.txt' | head -1", gcBucket))
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).NotTo(BeEmpty(),
				"canary written through AWS_ENDPOINT_URL not found inside the in-cluster MinIO pod — the endpoint is NOT the test MinIO; refusing to GC")
		}, 2*time.Minute, gcAssertPoll).Should(Succeed())
	}

	// gcRunCLI invokes the REAL built CLI with plain node, cwd = the rendered
	// app dir (kn-next.config.ts lives there).
	gcRunCLI := func(args ...string) utils.CLIResult {
		res, err := utils.RunCLIInDir(appDir, args...)
		Expect(err).NotTo(HaveOccurred(),
			"failed to spawn the CLI at all (is node installed and the CLI built?)")
		return res
	}

	BeforeAll(func() {
		By("checking the aws CLI is available (the s3 storage provider shells out to it)")
		_, err := exec.LookPath("aws")
		Expect(err).NotTo(HaveOccurred(),
			"the aws CLI is required (preinstalled on GitHub runners; `brew install awscli` locally)")

		By("building the CLI from source with pnpm (plain-Node dist, no Bun)")
		_, err = utils.RunAtRepoRoot("pnpm", "--filter", "@knext/core...", "build")
		Expect(err).NotTo(HaveOccurred(),
			"failed to build the CLI — run `pnpm install --frozen-lockfile` at the repo root first")
		bin, err := utils.CLIBin()
		Expect(err).NotTo(HaveOccurred())
		Expect(bin).To(BeAnExistingFile(), "CLI build produced no dist/cli/kn-next.js")

		if existing != "" {
			By(fmt.Sprintf("EXISTING-CLUSTER mode: pinning kube context %q (no operator install)", existing))
			Expect(utils.PinKubeContext(existing, GinkgoT().TempDir())).To(Succeed())
		} else {
			By("building the operator image LOCALLY (never a published image)")
			_, err = utils.Run(exec.Command("make", "docker-build",
				fmt.Sprintf("IMG=%s", gcOperatorImage)))
			Expect(err).NotTo(HaveOccurred(), "failed to build the operator image")

			By("loading the locally-built operator image into kind")
			Expect(utils.LoadImageToKindClusterWithName(gcOperatorImage)).
				To(Succeed(), "failed to load operator image into kind")

			By("rendering the install bundle via make build-installer")
			_, err = utils.Run(exec.Command("make", "build-installer"))
			Expect(err).NotTo(HaveOccurred(), "failed to render dist/install.yaml")

			By("overriding the manager image in the rendered bundle to the local image")
			renderedBundle, err = utils.OverrideManagerImage(gcOperatorImage, "install.gc-e2e.yaml")
			Expect(err).NotTo(HaveOccurred(), "failed to render the image-overridden bundle")

			By("applying the rendered install bundle (kubectl apply --server-side -f)")
			Expect(utils.ApplyOrDeleteBundle("apply", renderedBundle)).
				To(Succeed(), "failed to kubectl apply the install bundle")
		}

		By("waiting for the operator Deployment to be Available")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "deployment", gcOperatorDeploy,
				"-n", gcOperatorNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Available')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(out).To(Equal("True"), "operator Deployment not Available")
		}).Should(Succeed())

		By(fmt.Sprintf("creating the fresh, dedicated app namespace %q (ownership label stamped at creation)", gcAppNamespace))
		// The create stamps kn-next.dev/e2e-owned=true — the teardown guard's
		// authorization; a pre-existing namespace is never adopted: an
		// unlabeled "already exists" collision fails fast right here
		// (ErrForeignNamespace), before MinIO/the app is deployed into it (plan P5).
		Eventually(func(g Gomega) {
			err := utils.CreateOwnedNamespace(gcAppNamespace)
			if errors.Is(err, utils.ErrForeignNamespace) {
				StopTrying("ownership guard refused to run in a pre-existing, unowned namespace").
					Wrap(err).Now()
			}
			g.Expect(err).NotTo(HaveOccurred())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())

		By("waiting for the validating webhook to actually serve (Available ≠ webhook ready, #233)")
		Expect(utils.WaitForWebhookReady(gcAppNamespace)).To(Succeed(),
			"operator validating webhook never became reachable after Deployment Available")

		By("deploying the in-cluster MinIO (digest-pinned; creds in a K8s Secret; emptyDir)")
		credBytes := make([]byte, 16)
		_, err = rand.Read(credBytes)
		Expect(err).NotTo(HaveOccurred())
		minioUser := "gc-e2e-admin"
		minioPassword := hex.EncodeToString(credBytes) // throwaway, per-run
		Eventually(func(g Gomega) {
			g.Expect(utils.ApplyManifest(gcMinioManifest(minioUser, minioPassword))).To(Succeed())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "deployment", gcMinioName, "-n", gcAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Available')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(out).To(Equal("True"), "MinIO Deployment not Available")
		}).Should(Succeed())

		By("port-forwarding the MinIO Service to loopback and exporting the S3 env")
		localPort = 39000 + int(time.Now().UnixNano()%1000)
		endpointURL = fmt.Sprintf("http://127.0.0.1:%d", localPort)
		portForward = exec.Command("kubectl", "port-forward",
			"-n", gcAppNamespace, "svc/"+gcMinioName,
			fmt.Sprintf("%d:9000", localPort))
		portForward.Stdout = GinkgoWriter
		portForward.Stderr = GinkgoWriter
		Expect(portForward.Start()).To(Succeed(), "failed to start kubectl port-forward")

		// The suite's aws helper AND the CLI subprocess (utils.RunCLIInDir
		// inherits os.Environ) both read these — one endpoint, one credential
		// set, everywhere.
		Expect(os.Setenv("AWS_ENDPOINT_URL", endpointURL)).To(Succeed())
		Expect(os.Setenv("AWS_ACCESS_KEY_ID", minioUser)).To(Succeed())
		Expect(os.Setenv("AWS_SECRET_ACCESS_KEY", minioPassword)).To(Succeed())
		Expect(os.Setenv("AWS_DEFAULT_REGION", "us-east-1")).To(Succeed())
		Expect(os.Setenv("AWS_REGION", "us-east-1")).To(Succeed())
		Expect(os.Setenv("AWS_EC2_METADATA_DISABLED", "true")).To(Succeed())

		By("waiting for the forwarded S3 API to answer, then creating the suite bucket")
		Eventually(func(g Gomega) {
			out, err := gcAWS("s3api", "list-buckets")
			g.Expect(err).NotTo(HaveOccurred(), out)
		}, 3*time.Minute, gcAssertPoll).Should(Succeed())
		out, err := gcAWS("s3api", "create-bucket", "--bucket", gcBucket)
		if err != nil && !strings.Contains(out, "BucketAlreadyOwnedByYou") {
			Expect(err).NotTo(HaveOccurred(), out)
		}

		By("rendering the throwaway app dir with kn-next.config.ts (provider s3, assetRetention 1)")
		appDir, err = os.MkdirTemp("", "gc-e2e-app-*")
		Expect(err).NotTo(HaveOccurred())
		// assetRetention: 1 makes the scenario sharp: ONLY the live-set rule
		// protects the pinned oldest build; only --build-id sits in the window.
		config := fmt.Sprintf(`export default {
    name: %q,
    registry: "registry.invalid/gc-e2e",
    storage: {
        provider: "s3",
        bucket: %q,
        publicUrl: %q,
        assetRetention: 1,
    },
};
`, gcAppName, gcBucket, endpointURL+"/"+gcBucket)
		Expect(os.WriteFile(filepath.Join(appDir, "kn-next.config.ts"), []byte(config), 0o644)).
			To(Succeed())

		By("applying the NextApp WITHOUT spec.buildId (TARGET=rev1) — the fail-safe premise")
		Eventually(func(g Gomega) {
			g.Expect(utils.ApplyManifest(gcNextAppManifest("rev1", ""))).To(Succeed())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())

		By("waiting for the ksvc to become Ready and capturing revision-1")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "ksvc", gcAppName, "-n", gcAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).To(Equal("True"), "ksvc not Ready")
		}, 10*time.Minute, gcAssertPoll).Should(Succeed())
		Eventually(func(g Gomega) {
			rev1Name = gcLatestReadyRevision(g)
			g.Expect(rev1Name).NotTo(BeEmpty())
		}).Should(Succeed())
		_, _ = fmt.Fprintf(GinkgoWriter, "revision 1 (no build-id label): %s\n", rev1Name)
	})

	AfterAll(func() {
		if portForward != nil && portForward.Process != nil {
			_ = portForward.Process.Kill()
		}
		if appDir != "" {
			_ = os.RemoveAll(appDir)
		}

		By(fmt.Sprintf("deleting the dedicated app namespace %q (full cleanup — MinIO + app go with it)", gcAppNamespace))
		// OWNERSHIP-GUARDED delete (plan P5): a deterministic guard refusal
		// fails FAST and LOUD via StopTrying instead of burning the retry
		// budget — see utils.NamespaceTeardownAuthorized.
		Eventually(func(g Gomega) {
			err := utils.NamespaceDeletedConfirmed(gcAppNamespace)
			if errors.Is(err, utils.ErrTeardownRefused) {
				StopTrying("teardown ownership guard refused the namespace deletion").
					Wrap(err).Now()
			}
			g.Expect(err).NotTo(HaveOccurred())
		}, 10*time.Minute, gcAssertPoll).Should(Succeed(),
			"failed to fully delete the dedicated namespace %s", gcAppNamespace)

		if existing == "" {
			By("deleting the rendered bundle from the cluster")
			_ = utils.ApplyOrDeleteBundle("delete", renderedBundle)
			if renderedBundle != "" {
				_ = os.Remove(renderedBundle)
			}
		}
	})

	It("seeds the exact ADR-0008 layout and the fail-safe over-keep skip fires when a live revision lacks the build-id label", func() {
		By("asserting the negative premise: revision-1 carries NO build-id label (spec.buildId was omitted)")
		Eventually(func(g Gomega) {
			g.Expect(gcRevisionBuildIDLabel(g, rev1Name)).To(BeEmpty(),
				"rev1 must have no apps.kn-next.dev/build-id label for the fail-safe premise")
		}).Should(Succeed())

		By("asserting rev1 IS the live traffic (status.currentTraffic)")
		Eventually(func(g Gomega) {
			targets := gcCurrentTraffic(g)
			g.Expect(targets).To(HaveLen(1))
			g.Expect(targets[0].RevisionName).To(Equal(rev1Name))
		}, gcAssertTimeout, gcAssertPoll).Should(Succeed())

		By("seeding the object store in the EXACT ADR-0008/ADR-0011 layout via the S3 API")
		// Per-build-id prefixes (`<app>/_next/static/<id>/…`, each carrying
		// the `.knext-build` marker a real knext upload writes, #264) + ONE
		// deliberately UNMARKED prefix (pre-marker upload / unknown future dir
		// — must survive every prune, the marker-inversion negative spec) +
		// the shared non-build-id dirs real `next build` also emits under
		// `_next/static/` (chunks/css/media — the GC must NEVER classify these
		// as prunable build-ids) + bare-`<app>/` root keys (teardown-only,
		// ADR-0008).
		// NOTE (evidence boundary): seeding proves the pruner against this
		// layout; it does NOT prove a real `next build`+upload produces it —
		// see the package comment.
		for _, bid := range []string{gcBidPinned, gcBidReapA, gcBidReapB, gcBidNew} {
			for _, f := range []string{"_buildManifest.js", "_ssgManifest.js", gcMarkerFile} {
				Expect(gcSeedObject(gcStaticPrefix(bid) + f)).To(Succeed())
			}
		}
		// The unmarked prefix: real files, NO marker object.
		for _, f := range []string{"_buildManifest.js", "_ssgManifest.js"} {
			Expect(gcSeedObject(gcStaticPrefix(gcBidUnmarked) + f)).To(Succeed())
		}
		for _, key := range []string{
			gcAppName + "/_next/static/chunks/main-app-deadbeef.js",
			gcAppName + "/_next/static/css/app-cafebabe.css",
			gcAppName + "/_next/static/media/logo-12345678.svg",
			gcAppName + "/favicon.ico",
			gcAppName + "/robots.txt",
		} {
			Expect(gcSeedObject(key)).To(Succeed())
		}

		// 4 marked prefixes × 3 objects + 1 unmarked × 2 + 3 reserved + 2 root.
		seededBefore := 0
		Eventually(func(g Gomega) {
			keys := gcListAppKeys(g)
			g.Expect(len(keys)).To(BeNumerically(">=", 19), "seeding incomplete: %v", keys)
			seededBefore = len(keys)
		}).Should(Succeed())

		assertEndpointIsTestMinIO() // canary adds one more key
		seededBefore++

		By("running the REAL CLI: kn-next gc --build-id " + gcBidNew + " (a live revision is unresolvable)")
		res := gcRunCLI("gc", "--build-id", gcBidNew, "-n", gcAppNamespace)
		Expect(res.ExitCode).To(Equal(0),
			"gc must exit 0 on the fail-safe skip\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		Expect(res.Stdout).To(ContainSubstring("SKIPPED (fail-safe over-keep)"),
			"gc must report the fail-safe skip")
		Expect(res.Stdout).To(ContainSubstring(rev1Name),
			"the skip report must name the unresolvable live revision")

		By("asserting NOTHING was deleted (over-keep): every seeded key survives")
		keys := gcListAppKeys(Default)
		Expect(keys).To(HaveLen(seededBefore),
			"the fail-safe skip must not delete a single object; got %v", keys)
		for _, bid := range []string{gcBidUnmarked, gcBidPinned, gcBidReapA, gcBidReapB, gcBidNew} {
			Expect(gcKeysWithPrefix(keys, gcStaticPrefix(bid))).NotTo(BeEmpty(),
				"build prefix %s must be untouched by the skipped GC", bid)
		}
	})

	It("reaps ONLY unpinned out-of-window build prefixes: the pinned oldest + newest survive; reserved dirs + bare <app>/ untouched", func() {
		By("rolling revision-2 with spec.buildId=" + gcBidPinned + " and verifying the operator stamps the label")
		Eventually(func(g Gomega) {
			g.Expect(utils.ApplyManifest(gcNextAppManifest("rev2", gcBidPinned))).To(Succeed())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())
		Eventually(func(g Gomega) {
			rev2Name = gcLatestReadyRevision(g)
			g.Expect(rev2Name).NotTo(BeEmpty())
			g.Expect(rev2Name).NotTo(Equal(rev1Name), "no new revision was rolled")
		}, 10*time.Minute, gcAssertPoll).Should(Succeed())
		// THE stamping chain, live: spec.buildId → operator → revision label.
		Eventually(func(g Gomega) {
			g.Expect(gcRevisionBuildIDLabel(g, rev2Name)).To(Equal(gcBidPinned))
		}).Should(Succeed())
		_, _ = fmt.Fprintf(GinkgoWriter, "revision 2 (%s): %s\n", gcBidPinned, rev2Name)

		By("rolling revision-3 with spec.buildId=" + gcBidNew + " (the 'just deployed' build)")
		Eventually(func(g Gomega) {
			g.Expect(utils.ApplyManifest(gcNextAppManifest("rev3", gcBidNew))).To(Succeed())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())
		Eventually(func(g Gomega) {
			rev3Name = gcLatestReadyRevision(g)
			g.Expect(rev3Name).NotTo(BeEmpty())
			g.Expect(rev3Name).NotTo(Equal(rev2Name), "no third revision was rolled")
		}, 10*time.Minute, gcAssertPoll).Should(Succeed())
		Eventually(func(g Gomega) {
			g.Expect(gcRevisionBuildIDLabel(g, rev3Name)).To(Equal(gcBidNew))
		}).Should(Succeed())
		_, _ = fmt.Fprintf(GinkgoWriter, "revision 3 (%s): %s\n", gcBidNew, rev3Name)

		By("pinning the OLDEST labeled revision via the REAL CLI: kn-next rollback --to " + gcBidPinned)
		Eventually(func(g Gomega) {
			res := gcRunCLI("rollback", gcAppName, "--to", rev2Name, "-n", gcAppNamespace)
			g.Expect(res.ExitCode).To(Equal(0),
				"rollback must exit 0\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		}, gcAssertTimeout, gcAssertPoll).Should(Succeed())

		By("waiting until status.currentTraffic is EXACTLY the pinned revision (the GC's input)")
		// Load-bearing for determinism: gc reads currentTraffic; running it
		// against a half-reconciled split would compute a different live set.
		Eventually(func(g Gomega) {
			targets := gcCurrentTraffic(g)
			g.Expect(targets).To(HaveLen(1), "expected a single pinned target, got %+v", targets)
			g.Expect(targets[0].RevisionName).To(Equal(rev2Name))
			g.Expect(targets[0].Percent).To(Equal(int64(100)))
		}, gcAssertTimeout, gcAssertPoll).Should(Succeed())

		assertEndpointIsTestMinIO()

		By("running the REAL CLI: kn-next gc --build-id " + gcBidNew)
		res := gcRunCLI("gc", "--build-id", gcBidNew, "-n", gcAppNamespace)
		Expect(res.ExitCode).To(Equal(0),
			"gc must exit 0\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		Expect(res.Stdout).To(ContainSubstring("gc: completed"),
			"gc must report a completed prune")
		Expect(res.Stdout).To(ContainSubstring(rev2Name),
			"the completion report must name the protected live revision")

		By("asserting the ADR-0011 outcome on the store")
		keys := gcListAppKeys(Default)
		// The pinned revision's build — OLDEST marked, outside the retain
		// window (assetRetention=1) — survives on the live-set rule ALONE.
		// (2 files + the .knext-build marker.)
		Expect(gcKeysWithPrefix(keys, gcStaticPrefix(gcBidPinned))).To(HaveLen(3),
			"the PINNED revision's asset prefix must survive intact (the guarantee rollback rests on)")
		// The just-deployed build survives on the retain window.
		Expect(gcKeysWithPrefix(keys, gcStaticPrefix(gcBidNew))).To(HaveLen(3),
			"the newest build's prefix must survive (retain window)")
		// The unpinned, out-of-window builds are REAPED — the GC actually GCs
		// (and marker-carrying prefixes are still real candidates, #264).
		Expect(gcKeysWithPrefix(keys, gcStaticPrefix(gcBidReapA))).To(BeEmpty(),
			"unpinned out-of-window build %s must be reaped", gcBidReapA)
		Expect(gcKeysWithPrefix(keys, gcStaticPrefix(gcBidReapB))).To(BeEmpty(),
			"unpinned out-of-window build %s must be reaped", gcBidReapB)
		// #264 marker inversion — the NEGATIVE spec: the unmarked prefix
		// (pre-marker upload / unknown future dir) is out-of-window, not live,
		// and NOT reserved — under the old deny-list-only rule it would have
		// been reaped. It must survive intact, SKIPPED loudly by name.
		Expect(gcKeysWithPrefix(keys, gcStaticPrefix(gcBidUnmarked))).To(HaveLen(2),
			"the UNMARKED prefix %s (no %s marker) must be SKIPPED, never reaped", gcBidUnmarked, gcMarkerFile)
		Expect(res.Stdout).To(ContainSubstring(gcBidUnmarked),
			"the gc output must NAME the unmarked prefix it kept (loud over-keep)")
		// Next's shared non-build-id static dirs are NEVER prune candidates.
		for _, seg := range []string{"chunks", "css", "media"} {
			Expect(gcKeysWithPrefix(keys, gcStaticPrefix(seg))).NotTo(BeEmpty(),
				"reserved _next/static/%s/ must never be reaped (shared by every build)", seg)
		}
		// The bare `<app>/` namespace is teardown-only (ADR-0008): root keys
		// (and the endpoint canary) are untouched.
		for _, key := range []string{
			gcAppName + "/favicon.ico",
			gcAppName + "/robots.txt",
			gcAppName + "/endpoint-canary.txt",
		} {
			Expect(keys).To(HaveKey(key), "bare <app>/ key %s must never be touched by the GC", key)
		}
	})

	It("canary pin (#264 part 2): a TWO-target status.currentTraffic protects BOTH revisions' builds through a real prune — with --dry-run proven first", func() {
		By("seeding a fresh marked, unpinned, out-of-window build prefix so the canary-run prune has something REAL to reap")
		for _, f := range []string{"_buildManifest.js", "_ssgManifest.js", gcMarkerFile} {
			Expect(gcSeedObject(gcStaticPrefix(gcBidCanaryReap) + f)).To(Succeed())
		}

		By("splitting traffic via the REAL CLI: kn-next rollback --to " + gcBidPinned + "'s revision --canary 40")
		Eventually(func(g Gomega) {
			res := gcRunCLI("rollback", gcAppName,
				"--to", rev2Name, "--canary", "40", "-n", gcAppNamespace)
			g.Expect(res.ExitCode).To(Equal(0),
				"rollback --canary must exit 0\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		}, gcAssertTimeout, gcAssertPoll).Should(Succeed())

		By("waiting until status.currentTraffic carries EXACTLY the two targets: pinned 60% + latest-ready 40%")
		// Load-bearing for the leg's whole point: the GC's live set must be
		// resolved from a MULTI-target status, not the single-pin case the
		// previous spec already proved.
		Eventually(func(g Gomega) {
			targets := gcCurrentTraffic(g)
			g.Expect(targets).To(HaveLen(2), "expected a two-target canary split, got %+v", targets)
			byRev := map[string]int64{}
			for _, t := range targets {
				byRev[t.RevisionName] = t.Percent
			}
			g.Expect(byRev).To(HaveKeyWithValue(rev2Name, int64(60)),
				"the pinned revision must hold 100-canary percent")
			g.Expect(byRev).To(HaveKeyWithValue(rev3Name, int64(40)),
				"latest-ready must hold the canary percent")
		}, gcAssertTimeout, gcAssertPoll).Should(Succeed())

		assertEndpointIsTestMinIO()

		By("DRY-RUN first: kn-next gc --dry-run prints the full plan and deletes NOTHING")
		keysBefore := gcListAppKeys(Default)
		res := gcRunCLI("gc", "--dry-run", "--build-id", gcBidNew, "-n", gcAppNamespace)
		Expect(res.ExitCode).To(Equal(0),
			"gc --dry-run must exit 0\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		Expect(res.Stdout).To(ContainSubstring("DRY-RUN"),
			"gc --dry-run must announce itself")
		Expect(res.Stdout).To(ContainSubstring("nothing was deleted"))
		Expect(res.Stdout).To(ContainSubstring(gcBidCanaryReap),
			"the dry-run plan must NAME the would-reap candidate")
		keysAfterDry := gcListAppKeys(Default)
		Expect(keysAfterDry).To(HaveLen(len(keysBefore)),
			"gc --dry-run must not delete a single object")
		Expect(gcKeysWithPrefix(keysAfterDry, gcStaticPrefix(gcBidCanaryReap))).To(HaveLen(3),
			"the would-reap candidate must be untouched by --dry-run")

		By("running the REAL CLI: kn-next gc --build-id " + gcBidNew + " under the two-target split")
		res = gcRunCLI("gc", "--build-id", gcBidNew, "-n", gcAppNamespace)
		Expect(res.ExitCode).To(Equal(0),
			"gc must exit 0\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		Expect(res.Stdout).To(ContainSubstring("gc: completed"),
			"gc must report a completed prune")
		// The completion report must name BOTH protected live revisions.
		Expect(res.Stdout).To(ContainSubstring(rev2Name))
		Expect(res.Stdout).To(ContainSubstring(rev3Name))

		By("asserting BOTH live builds survive AND the unpinned candidate was reaped (the prune was real)")
		keys := gcListAppKeys(Default)
		Expect(gcKeysWithPrefix(keys, gcStaticPrefix(gcBidPinned))).To(HaveLen(3),
			"the canary-PINNED old revision's build must survive the two-target live set")
		Expect(gcKeysWithPrefix(keys, gcStaticPrefix(gcBidNew))).To(HaveLen(3),
			"the latest-ready revision's build must survive (window + live)")
		Expect(gcKeysWithPrefix(keys, gcStaticPrefix(gcBidCanaryReap))).To(BeEmpty(),
			"the unpinned out-of-window candidate must be reaped — proving the live-set protection held through a REAL prune, not a no-op")
		// The marker-inversion + reserved-dir guarantees keep holding.
		Expect(gcKeysWithPrefix(keys, gcStaticPrefix(gcBidUnmarked))).To(HaveLen(2),
			"the unmarked prefix must keep surviving every prune")
		for _, seg := range []string{"chunks", "css", "media"} {
			Expect(gcKeysWithPrefix(keys, gcStaticPrefix(seg))).NotTo(BeEmpty(),
				"reserved _next/static/%s/ must never be reaped", seg)
		}
	})

	It("live pin+wiped-status (#264 part 2): a NextApp pinning a revision while status.currentTraffic is empty ⇒ gc SKIPS loudly, ZERO deletions", func() {
		// MECHANISM (the least-artificial way to hold this state on a real
		// cluster, deliberately chosen):  create a SECOND NextApp whose
		// spec.traffic.revisionName points at a revision that does not exist.
		// That is a REAL, user-reachable state the operator itself names
		// (ADR-0014 PinnedRevisionNotFound — "the pin outlives the revision"):
		// e.g. a GitOps re-apply of a pinned CR, where the status subresource
		// is never persisted in Git and the recreated ksvc's revisions get NEW
		// names, so the old pin can never resolve. Knative keeps the route
		// unprogrammed (RevisionMissing) ⇒ ksvc status.traffic stays empty ⇒
		// the operator reconciles status with an EMPTY currentTraffic while
		// the spec pin stands — deterministically, for as long as the spec
		// needs. Alternatives rejected: patching the status subresource with
		// the suite's admin rights RACES the operator's reconcile loop (it
		// re-populates status on the very watch event the patch fires) and
		// proves an artificial state; scaling the operator down to freeze
		// status mutates cluster state OUTSIDE the throwaway namespace,
		// violating the suite's blast-radius contract in existing-cluster mode.
		pinnedRevision := gcPinnedAppName + "-00042" // never created
		pinnedStatic := func(seg string) string {
			return gcPinnedAppName + "/_next/static/" + seg + "/"
		}

		By("rendering a second throwaway app dir for " + gcPinnedAppName)
		pinnedDir, err := os.MkdirTemp("", "gc-e2e-pinned-*")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(func() { _ = os.RemoveAll(pinnedDir) })
		pinnedConfig := fmt.Sprintf(`export default {
    name: %q,
    registry: "registry.invalid/gc-e2e",
    storage: {
        provider: "s3",
        bucket: %q,
        publicUrl: %q,
        assetRetention: 1,
    },
};
`, gcPinnedAppName, gcBucket, endpointURL+"/"+gcBucket)
		Expect(os.WriteFile(filepath.Join(pinnedDir, "kn-next.config.ts"), []byte(pinnedConfig), 0o644)).
			To(Succeed())

		By("seeding MARKED build prefixes a window-only prune WOULD reap (retain=1) — the skip assertion has teeth")
		for _, bid := range []string{gcPinnedBidOld1, gcPinnedBidOld2, gcPinnedBidNew} {
			for _, f := range []string{"_buildManifest.js", "_ssgManifest.js", gcMarkerFile} {
				Expect(gcSeedObject(pinnedStatic(bid) + f)).To(Succeed())
			}
		}

		By("creating the NextApp with spec.traffic.revisionName pinned to the nonexistent " + pinnedRevision)
		Eventually(func(g Gomega) {
			g.Expect(utils.ApplyManifest(gcPinnedAppManifest(pinnedRevision))).To(Succeed())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())

		By("waiting until the operator HAS reconciled it (Ready condition written) — the empty currentTraffic is the operator's observed truth, not a not-yet-reconciled blank")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", gcPinnedAppName, "-n", gcAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).NotTo(BeEmpty(),
				"operator has not written status.conditions for the pinned NextApp yet")
		}, gcAssertTimeout, gcAssertPoll).Should(Succeed())

		By("asserting the premise: spec pins a revision AND status.currentTraffic is EMPTY")
		out, err := utils.Kubectl("get", "nextapp", gcPinnedAppName, "-n", gcAppNamespace,
			"-o", "jsonpath={.status.currentTraffic}")
		Expect(err).NotTo(HaveOccurred(), out)
		Expect(strings.TrimSpace(out)).To(BeEmpty(),
			"premise broken: status.currentTraffic must be EMPTY while the spec pin cannot resolve")

		assertEndpointIsTestMinIO()

		By("running the REAL CLI: kn-next gc --build-id " + gcPinnedBidNew + " against the pinned/empty-status app")
		res, err := utils.RunCLIInDir(pinnedDir, "gc", "--build-id", gcPinnedBidNew, "-n", gcAppNamespace)
		Expect(err).NotTo(HaveOccurred(), "failed to spawn the CLI at all")
		Expect(res.ExitCode).To(Equal(0),
			"gc must exit 0 on the fail-safe skip\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		Expect(res.Stdout).To(ContainSubstring("SKIPPED (fail-safe over-keep)"),
			"gc must report the fail-safe skip")
		Expect(res.Stdout).To(ContainSubstring("pinned-with-empty-status"),
			"the skip must carry the machine-greppable reason token")
		Expect(res.Stdout).To(ContainSubstring(pinnedRevision),
			"the skip report must NAME the pinned revision")

		By("asserting ZERO deletions: every window-reapable prefix survives intact")
		keys := gcListKeysUnder(Default, gcPinnedAppName)
		for _, bid := range []string{gcPinnedBidOld1, gcPinnedBidOld2, gcPinnedBidNew} {
			Expect(gcKeysWithPrefix(keys, pinnedStatic(bid))).To(HaveLen(3),
				"prefix %s must be untouched by the skipped GC", bid)
		}
	})
})
