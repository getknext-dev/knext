//go:build e2e_scale
// +build e2e_scale

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

// Package e2e — the LIVE-CLUSTER half of image prewarm (#471 item 1).
//
// WHAT THIS PROVES, ON A REAL NODE (which envtest cannot):
//
//	That the staged-helper mechanism actually runs under a real kubelet and
//	container runtime. The initContainer copies a static busybox into a shared
//	emptyDir and the MAIN container runs the APP IMAGE with its command pointed
//	at that copied binary. If any part of that hand-off is wrong — the helper
//	never lands in the emptyDir, the copied binary is not executable, the
//	non-root uid conflicts with readOnlyRootFilesystem, the app's own ENTRYPOINT
//	runs instead — the pod CrashLoopBackOffs. envtest has no kubelet and no
//	container runtime, so it sees none of that: it happily reports a DaemonSet
//	whose pods would never start. Here the pods must reach Ready on every node
//	with ZERO restarts.
//
//	It also proves the app server never boots inside the prewarmer, that the pin
//	container references the APP image (so the right digest is pinned), and the
//	enable -> disable lifecycle (DaemonSet removed, condition dropped).
//
// WHAT THIS DOES **NOT** PROVE — read this before citing it:
//
//  1. NOT the distroless / shell-less case. The app image under test is
//     SCALE_TEST_IMAGE, i.e. the file-manager image, whose runner stage is
//     `node:22-alpine` (apps/file-manager/Dockerfile) — Alpine ships busybox and
//     /bin/sh, so a naive `sleep infinity` command would work there too. This
//     spec therefore CANNOT distinguish the shell-free mechanism from a
//     shell-dependent one. Closing that gap needs a genuinely distroless,
//     digest-pinned app image (e.g. a knext runtime image on
//     gcr.io/distroless/nodejs) plumbed in as the e2e app image; until then the
//     ADR-0037 action item stays unchecked. Do not let the presence of this file
//     be read as the distroless proof.
//
//  2. NOT the no-`Pulling`-on-cold-start proof, and not the warm-vs-cold ~2 s
//     delta. kind side-loads images into every node's containerd, so "no
//     Pulling event" is trivially true there whether or not the prewarmer
//     works — a green that proves nothing. That measurement needs a multi-node
//     cluster pulling from a real registry (OKE).
//
// AND KNOW WHERE IT RUNS: `make test-e2e-scale` on the nightly gates the whole
// scale suite on `vars.SCALE_TEST_IMAGE`, which is UNSET on this repo
// (`gh api repos/getknext-dev/knext/actions/variables` → total_count 0), and an
// unset value only logs a `::warning::` and skips the step. So as the repo is
// configured today this spec does NOT run on the schedule — it runs only on a
// manual `workflow_dispatch` that supplies an image. Setting that variable is
// what makes it a live gate.
//
// NOTHING INSIDE THE SPEC SKIPS. A missing cluster, a missing image or a
// DaemonSet that never schedules FAILS. (The workflow-level skip above is a
// separate, real gap — stated rather than papered over.)
package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

const (
	prewarmNamespace = "kn-next-prewarm-test"
	prewarmAppName   = "imgcache-app"
	prewarmDSName    = prewarmAppName + "-imgcache"
)

var _ = Describe("Image prewarm on a live cluster (#471)", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	BeforeAll(func() {
		By("creating the prewarm-test namespace")
		_, _ = utils.Kubectl("create", "ns", prewarmNamespace)

		By("applying a NextApp CR with scaling.imagePrewarm=true")
		Expect(applyManifest(prewarmAppManifest(true))).To(Succeed(),
			"failed to apply the prewarm NextApp CR")
	})

	AfterAll(func() {
		By("deleting the prewarm-test namespace")
		_, _ = utils.Kubectl("delete", "ns", prewarmNamespace, "--ignore-not-found")
	})

	It("runs the prewarmer on every node without CrashLooping the app image", func() {
		By("waiting for the imgcache DaemonSet to be scheduled on every node")
		var desired int
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "daemonset", prewarmDSName, "-n", prewarmNamespace,
				"-o", "jsonpath={.status.desiredNumberScheduled}")
			g.Expect(err).NotTo(HaveOccurred(), "imgcache DaemonSet not created")
			n, convErr := parseInt(strings.TrimSpace(out))
			g.Expect(convErr).NotTo(HaveOccurred())
			g.Expect(n).To(BeNumerically(">", 0),
				"DaemonSet targets zero nodes — it is proving nothing")
			desired = n
		}).Should(Succeed())

		By("waiting for every prewarm pod to reach Ready")
		// THE distroless-safety assertion: a `sleep infinity` on a shell-less app
		// image would sit in CrashLoopBackOff here forever.
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "daemonset", prewarmDSName, "-n", prewarmNamespace,
				"-o", "jsonpath={.status.numberReady}")
			g.Expect(err).NotTo(HaveOccurred())
			n, convErr := parseInt(strings.TrimSpace(out))
			g.Expect(convErr).NotTo(HaveOccurred())
			g.Expect(n).To(Equal(desired),
				"prewarm pods are not Ready on every node — the pin container is likely "+
					"CrashLoopBackOff on the (shell-less) app image")
		}).Should(Succeed())

		By("asserting NO prewarm container has ever restarted")
		// numberReady can go True after a crash-and-recover; a restart count > 0
		// means the mechanism is flapping, which the ready count alone hides.
		out, err := utils.Kubectl("get", "pods", "-n", prewarmNamespace,
			"-l", "apps.kn-next.dev/imgcache="+prewarmAppName,
			"-o", "jsonpath={.items[*].status.containerStatuses[*].restartCount}")
		Expect(err).NotTo(HaveOccurred())
		counts := strings.Fields(strings.TrimSpace(out))
		Expect(counts).NotTo(BeEmpty(), "no prewarm pods found — the label selector is wrong, "+
			"so this assertion would pass vacuously")
		for _, c := range counts {
			Expect(c).To(Equal("0"),
				"a prewarm container restarted (restartCounts=%v) — the app image is being "+
					"executed in a way it cannot survive", counts)
		}
	})

	It("pins the APP image without ever booting the app server", func() {
		By("reading the pin container's image and command")
		out, err := utils.Kubectl("get", "daemonset", prewarmDSName, "-n", prewarmNamespace,
			"-o", "jsonpath={.spec.template.spec.containers[0]}")
		Expect(err).NotTo(HaveOccurred())

		var container struct {
			Image   string   `json:"image"`
			Command []string `json:"command"`
		}
		Expect(json.Unmarshal([]byte(out), &container)).To(Succeed())

		// Pinning only works if a RUNNING container references the APP digest —
		// a helper/pause image would pin the wrong thing.
		Expect(container.Image).To(Equal(prewarmImage()),
			"the pin container must run the APP image, or it pins the wrong image")
		// ...but it must NOT run the app's entrypoint.
		Expect(container.Command).NotTo(BeEmpty(),
			"an empty command means the app image's own ENTRYPOINT runs — the app server "+
				"would boot inside the prewarmer")
		Expect(container.Command[0]).To(HavePrefix("/knext-pin/"),
			"the pin command must be the staged static helper, not anything from the app image")

		By("asserting the app server produced no output in the prewarm pod")
		podName, err := utils.Kubectl("get", "pods", "-n", prewarmNamespace,
			"-l", "apps.kn-next.dev/imgcache="+prewarmAppName,
			"-o", "jsonpath={.items[0].metadata.name}")
		Expect(err).NotTo(HaveOccurred())
		Expect(strings.TrimSpace(podName)).NotTo(BeEmpty())
		logs, err := utils.Kubectl("logs", strings.TrimSpace(podName), "-n", prewarmNamespace,
			"-c", "pin")
		Expect(err).NotTo(HaveOccurred())
		Expect(strings.TrimSpace(logs)).To(BeEmpty(),
			"the pin container emitted output — something other than a silent `sleep` is "+
				"running, i.e. the app server may have booted")
	})

	It("reports ImageCacheReady=True on the NextApp", func() {
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", prewarmAppName, "-n", prewarmNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='ImageCacheReady')].status}")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(strings.TrimSpace(out)).To(Equal("True"),
				"ImageCacheReady never went True while every prewarm pod is Ready")
		}).Should(Succeed())
	})

	It("removes the DaemonSet and the condition when prewarm is turned off", func() {
		By("re-applying the CR with scaling.imagePrewarm=false")
		Expect(applyManifest(prewarmAppManifest(false))).To(Succeed())

		By("waiting for the imgcache DaemonSet to disappear")
		Eventually(func(g Gomega) {
			out, _ := utils.Kubectl("get", "daemonset", prewarmDSName, "-n", prewarmNamespace,
				"--ignore-not-found", "-o", "name")
			g.Expect(strings.TrimSpace(out)).To(BeEmpty(),
				"imgcache DaemonSet still exists after imagePrewarm was disabled — it is still "+
					"holding the image (and a pod slot) on every node")
		}).Should(Succeed())

		By("waiting for the ImageCacheReady condition to be dropped")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", prewarmAppName, "-n", prewarmNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='ImageCacheReady')].type}")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(strings.TrimSpace(out)).To(BeEmpty(),
				"status still claims an image cache that no longer exists")
		}).Should(Succeed())
	})
})

// prewarmImage is the digest-pinned app image under test. It reuses the same
// SCALE_TEST_IMAGE the rest of the e2e_scale suite builds and pushes — the
// file-manager image, whose runner stage is `node:22-alpine`.
//
// Alpine is NOT distroless: it ships busybox and /bin/sh. So this image
// exercises the staged-helper hand-off on a real kubelet, but it does NOT
// exercise the shell-less case (see the package doc, point 1). Swapping this for
// a genuinely distroless app image is what closes that ADR-0037 action item.
func prewarmImage() string {
	if v := os.Getenv("SCALE_TEST_IMAGE"); v != "" {
		return v
	}
	return scaleAppImageDefault
}

func prewarmAppManifest(prewarm bool) string {
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
    imagePrewarm: %t
`, prewarmAppName, prewarmNamespace, prewarmImage(), prewarm)
}

// parseInt is a tiny helper so a non-numeric jsonpath result (an empty status
// field, say) FAILS with a clear message rather than silently reading as 0.
func parseInt(s string) (int, error) {
	if s == "" {
		return 0, fmt.Errorf("empty value where an integer was expected (field not populated yet)")
	}
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return 0, fmt.Errorf("not an integer: %q", s)
	}
	return n, nil
}
