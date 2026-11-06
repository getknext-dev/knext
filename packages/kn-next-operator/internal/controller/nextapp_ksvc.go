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

package controller

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// buildDesiredKsvc mutates ksvc toward the desired state derived from the
// NextApp spec: labels, autoscaling/observability annotations, the full env
// assembly (system env, storage/cache/revalidation, observability, secrets
// envFrom/envMap, spec.env with collision warnings), probes, resources,
// runtime command, the build-id revision label (#93), and the traffic split
// (#92). Moved VERBATIM out of the CreateOrUpdate closure in Reconcile (#254
// companion move) — behavior-preserving; the rendered-output envtests
// (reconcile_output_test.go, spec_env_test.go) are the characterization net.
// Not fully pure: a colliding spec.env name emits a Warning event (#186).
// readinessProbePath returns the SHALLOW health path that backs the Knative
// readiness + liveness probes (#338, ADR-0026). It must NOT resolve to a handler
// that deep-checks a scale-to-zero DB, or readiness flaps on every cold wake. It
// honours spec.healthCheckPath when set (the app owns the shallow endpoint),
// defaulting to /api/health (which the app serves shallow).
func readinessProbePath(nextApp *appsv1alpha1.NextApp) string {
	if nextApp.Spec.HealthCheckPath != "" {
		return nextApp.Spec.HealthCheckPath
	}
	return "/api/health"
}

// deepHealthPath is the DEEP dependency-reachability path used by
// observability/alerting only — never wired to a probe (#338, ADR-0026).
func deepHealthPath(nextApp *appsv1alpha1.NextApp) string {
	return readinessProbePath(nextApp) + "/deep"
}

// isSelfContainedShape reports whether nextApp compiles to ONE executable
// with no `.next/standalone` tree and no `node_modules` — true vinext
// (`Build == "vinext"`) and the standalone bundler's self-contained compile
// (`SelfContained: true` on any other Build value) are the SAME shape for
// this purpose (#1522, mirrors the containerCommand branch in
// buildDesiredKsvc). Both ship via `Dockerfile.self-contained.hbs`, whose
// binary unpacks sharp's native libraries into `$TMPDIR` (default /tmp) on
// the FIRST image-optimization request, then `dlopen()`s them — a write (and
// EXEC) that has nothing to do with `writableCache` or `spec.storage`, so it
// is handled as its own case below rather than folded into either.
func isSelfContainedShape(nextApp *appsv1alpha1.NextApp) bool {
	return nextApp.Spec.Build == lcVinext || nextApp.Spec.SelfContained
}

// buildWritableVolumes renders the emptyDir volumes + mounts the app
// container needs to keep working under readOnlyRootFilesystem (#1332).
// Returns (nil, nil) when the root stays writable.
//
// #1778/#1786 round 2: provisioning this volume measurably costs cold-start
// time (~300-360ms of pod-sandbox setup per wake, OKE + GKE,
// `docs/benchmarks/cold-start-gke-runtime-and-minimisation-2026-10-01.md`)
// whether or not anything is ever written to it, so it is no longer
// provisioned UNCONDITIONALLY. It is still provisioned, by default, for the
// two write paths that are NOT optional (an adversarial review of the first
// round of this change caught both — neither is behind `writableCache`):
//
//   - /tmp, whenever this is a self-contained-compiled shape
//     (`isSelfContainedShape`): the binary unpacks sharp's native libraries
//     there on the first image-optimization request and `dlopen()`s them —
//     without a writable+executable /tmp this 500s every optimized-image
//     request on every app of this shape, not just ones with `writableCache`
//     set. See `Dockerfile.self-contained.hbs:11-22`.
//   - `.next/standalone/.next/cache` (STANDALONE shape only — a
//     self-contained image has no `.next/standalone` tree, so this never
//     applies there), whenever `spec.storage` is configured: Next's built-in
//     image optimizer writes the uncompressed variant under
//     `.next/cache/images` BEFORE `image-cache-sync.ts` can sync it to the
//     object store, and that sync's own `restore`/push also `mkdir`s inside
//     this directory (`image-cache-sync.ts:140,301`) — unguarded, so it
//     throws EROFS rather than failing open. Without the mount, a
//     storage-configured app's sync loop errors on every wake and every
//     image request re-optimizes from scratch, defeating the whole point of
//     configuring storage. This is NOT limited to the no-storage case the
//     original #1778 write-up described — storage does not remove this
//     local write, it only adds a step that depends on it succeeding.
//
// `writeFree: true` (set by the CLI for an image it built and knows is
// write-free — a vinext disk-mode binary, a self-contained standalone
// executable, or a standalone build whose image cache is routed through the
// knext cache handler) drops BOTH shape-inferred mounts above, so such an app
// gets no emptyDir at all.
//
// `writableCache: true` additionally provisions both mounts unconditionally
// (the pre-#1778 behaviour) for an app that wants guaranteed local writes
// outside the two cases above — e.g. an app with no `cacheHandler` that
// relies on Next's on-disk ISR/fetch-cache fallback. See SecuritySpec's doc
// comments for the full default-vs-opt-in semantics and what an app gives up
// staying on the bare default (nothing fatal: the remaining writes — the
// already-accepted `.next/server/app/**` gap, and a no-storage app's image
// cache — fail EROFS non-fatally, logged, degraded to recompute-on-every-
// request rather than crashing).
func buildWritableVolumes(nextApp *appsv1alpha1.NextApp, readOnlyRootFS bool, writableCache bool) ([]corev1.Volume, []corev1.VolumeMount) {
	if !readOnlyRootFS {
		return nil, nil
	}

	selfContained := isSelfContainedShape(nextApp)
	storageConfigured := nextApp.Spec.Storage != nil && nextApp.Spec.Storage.Provider != ""
	// spec.security.writeFree: the CLI that built this image states its
	// runtime writes nothing to local disk, so neither shape-inferred mount
	// below is needed. writableCache (the user's escape hatch) still wins.
	writeFree := nextApp.Spec.Security != nil && nextApp.Spec.Security.WriteFree != nil &&
		*nextApp.Spec.Security.WriteFree

	mountTmp := writableCache || (selfContained && !writeFree)
	// `.next/cache` never applies to a self-contained image — it has no
	// `.next/standalone` tree at all (see isSelfContainedShape).
	mountNextCache := !selfContained && (writableCache || (storageConfigured && !writeFree))

	if !mountTmp && !mountNextCache {
		return nil, nil
	}

	const writableVolumeName = "knext-writable"
	volumes := []corev1.Volume{
		{Name: writableVolumeName, VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
	}
	var volumeMounts []corev1.VolumeMount
	if mountTmp {
		volumeMounts = append(volumeMounts, corev1.VolumeMount{Name: writableVolumeName, MountPath: "/tmp", SubPath: "tmp"})
	}
	if mountNextCache {
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name:      writableVolumeName,
			MountPath: "/app/.next/standalone/.next/cache",
			SubPath:   "next-cache",
		})
	}
	return volumes, volumeMounts
}

// eff carries the MERGED defaults (app > platform > built-in, ADR-0064 D2) the
// renderer stamps wherever the app left a field unset. With no KnextPlatform it
// is exactly the built-in table, which is what keeps this function's output
// byte-identical to its pre-platform self (zero_diff_golden_test.go).
func (r *NextAppReconciler) buildDesiredKsvc(nextApp *appsv1alpha1.NextApp, ksvc *servingv1.Service, eff effectiveValues) (envMapCollisionReport, error) {
	// Determine the SHALLOW readiness/liveness probe path (#338).
	healthPath := readinessProbePath(nextApp)

	if ksvc.Labels == nil {
		ksvc.Labels = make(map[string]string)
	}
	ksvc.Labels["app"] = nextApp.Name
	ksvc.Labels["generated-by"] = "kn-next-operator"

	// Visibility (#1865): spec.networking.visibility == "cluster-local" renders
	// the Knative label that keeps this ksvc's Route off the external gateway —
	// the platform way to satisfy "no unauthenticated mutating endpoints" for an
	// app with no auth of its own. The operator is the label's sole writer
	// (ADR-0001), so it is re-asserted on every reconcile; explicitly DELETED
	// (not just left unset) so toggling visibility back to "public" on an
	// existing app removes a previously-rendered label rather than leaving it
	// stale. Unset/"public" => absent, byte-identical to every CR written
	// before this field existed. Set before the preview override below (#770's
	// disposition list), deliberately NOT special-cased there: a preview of a
	// private app stays private, and vice versa.
	if nextApp.Spec.Networking != nil && nextApp.Spec.Networking.Visibility == appsv1alpha1.VisibilityClusterLocal {
		ksvc.Labels["networking.knative.dev/visibility"] = "cluster-local"
	} else {
		delete(ksvc.Labels, "networking.knative.dev/visibility")
	}

	annotations := map[string]string{
		"autoscaling.knative.dev/min-scale": "0",
		"autoscaling.knative.dev/max-scale": "10",
	}
	// Effective min-scale = max(Spec.MinScale, active warm-schedule floor). The
	// OPERATOR is the SINGLE writer of min-scale (ADR-0030, #380): on every
	// reconcile it evaluates the warmSchedule windows against NOW and folds the
	// active-window floor into the min-scale it stamps here. No external writer
	// (no CronJob) ever races the operator, so there is no revert/thrash. Outside
	// every window the floor is Spec.MinScale (default 0), preserving
	// scale-to-zero. Reconcile() additionally RequeueAfter's the next window
	// boundary so the floor flips at start/end without waiting for an unrelated
	// reconcile.
	minScale := int32(0)
	if nextApp.Spec.Scaling != nil {
		minScale = nextApp.Spec.Scaling.MinScale
		annotations["autoscaling.knative.dev/max-scale"] = fmt.Sprintf("%d", nextApp.Spec.Scaling.MaxScale)
	}
	if floor, _, _ := warmScheduleFloor(nextApp, r.now()); floor > minScale {
		minScale = floor
	}
	annotations["autoscaling.knative.dev/min-scale"] = fmt.Sprintf("%d", minScale)

	// TargetBurstCapacity (#411, ADR-0032): whether the activator stays in the
	// request path as a burst buffer. Only stamped when the field is
	// EXPLICITLY set — nil leaves the annotation absent so the Knative
	// cluster default (200) applies unmanaged, exactly as before this field
	// existed (byte-identical back-compat). Written into the SAME annotations
	// map as min-scale/max-scale/containerConcurrency. Its preview fate is
	// PASSED THROUGH — recorded in the override's single disposition list
	// below (#770), the one enumeration of what preview forces, drops, and
	// passes; do not restate the list here.
	if eff.targetBurstCapacity != nil {
		annotations["autoscaling.knative.dev/target-burst-capacity"] = fmt.Sprintf("%d", *eff.targetBurstCapacity)
	}

	// PanicWindowPercentage / PanicThresholdPercentage (#413, ADR-0033): how
	// fast the KPA reacts to an unpredicted surge. Only stamped when
	// EXPLICITLY set — nil leaves the annotation absent so the Knative
	// cluster defaults (10% window / 200% threshold) apply unmanaged, exactly
	// as before this field existed (byte-identical back-compat). Written into
	// the SAME annotations map as min-scale/max-scale/containerConcurrency/
	// targetBurstCapacity. Its preview fate is PASSED THROUGH — recorded in
	// the override's single disposition list below (#770); do not restate
	// the list here.
	if eff.panicWindowPercentage != nil {
		annotations["autoscaling.knative.dev/panic-window-percentage"] = fmt.Sprintf("%d", *eff.panicWindowPercentage)
	}
	if eff.panicThresholdPercentage != nil {
		annotations["autoscaling.knative.dev/panic-threshold-percentage"] = fmt.Sprintf("%d", *eff.panicThresholdPercentage)
	}

	// ScaleDownDelay (#762, ADR-0045): how long the last pod stays ROUTABLE
	// after traffic stops, so a request arriving shortly afterwards is a warm
	// hit instead of either a cold start or — the worst observed mode — a
	// stall in the scale-down transition. Only stamped when EXPLICITLY set —
	// "" leaves the annotation absent so the Knative cluster default applies
	// unmanaged, exactly as before this field existed (byte-identical
	// back-compat). The value is passed through VERBATIM: it was parsed and
	// range-checked once in validation.ValidateNextAppSpec (ADR-0040), and
	// re-parsing CR input here is exactly the MustParse-at-the-use-site
	// pattern #435/#455 removed. Written into the SAME annotations map as
	// min-scale/max-scale/targetBurstCapacity/the panic pair. UNLIKE those, it
	// is DROPPED by the preview-env override below (#770) — read the
	// disposition list there before assuming a stamped delay survives.
	if eff.scaleDownDelay != "" {
		annotations["autoscaling.knative.dev/scale-down-delay"] = eff.scaleDownDelay
	}

	// Observability annotations — aligned with CLI
	if nextApp.Spec.Observability != nil && nextApp.Spec.Observability.Enabled {
		annotations["prometheus.io/scrape"] = lcTrue
		// 9464, NOT 9091: queue-proxy owns :9091 on a stock serving install
		// (#951). In lockstep with the runtime entries' METRICS_PORT default,
		// appMetricsPort below, and the shipped PodMonitor
		// (metrics-port-lockstep.test.ts).
		annotations["prometheus.io/port"] = "9464"
		annotations["prometheus.io/path"] = "/metrics"
	}

	if nextApp.Spec.Preview != nil && nextApp.Spec.Preview.Enabled {
		ksvc.Labels["environment"] = "preview"
		ksvc.Labels["pr-id"] = nextApp.Spec.Preview.PRID

		// A preview is EPHEMERAL (ADR-0013), so this block trades warmth for
		// cluster cost. The COMPLETE disposition of every autoscaling knob the
		// code above may have stamped:
		//
		//   FORCED   max-scale=1                            (one pod per preview)
		//   FORCED   min-scale=0                            (never keep one warm)
		//   FORCED   scale-to-zero-pod-retention-period=30s (short idle window)
		//   DROPPED  scale-down-delay                       (#770, see below)
		//   PASSED   target-burst-capacity (#411), panic-window-percentage and
		//            panic-threshold-percentage (#413) — reaction-shape knobs
		//            that cost nothing idle, so a preview keeps the user's values.
		//   PASSED   containerConcurrency (#377, ADR-0028) — stamped as a ksvc
		//            TEMPLATE FIELD, not an annotation (see :~985), which is why it
		//            was missing from this list for so long. It shapes WHEN Knative
		//            adds a pod, not idle cost, so a preview keeps the user's value.
		//   PASSED   timeoutSeconds — also a template field. Not an autoscaling knob
		//            (a per-request duration cap), listed so the field-shaped blind
		//            spot stays visible rather than being rediscovered. The other two
		//            RevisionSpec knobs (responseStartTimeoutSeconds,
		//            idleTimeoutSeconds) are left nil today; the guard REFLECTS over
		//            RevisionSpec, so rendering either without a disposition reds CI.
		//
		// scale-down-delay is DROPPED, not clamped: previews predate the field,
		// so dropping restores their exact prior behaviour — the Knative cluster
		// default applies unmanaged, the same posture the field's unset case uses
		// — whereas a min()-style clamp would need duration parsing here (the
		// MustParse-at-the-use-site pattern #435/#455 removed) and a comparison
		// table to document, for no measurable preview benefit. The forced 30s
		// pod-retention already bounds preview idle cost. Production revisions
		// are untouched: the drop lives inside the preview branch.
		//
		// LESSON (#770): scale-down-delay is the SECOND scaling knob to leak
		// silently through this list — enumeration is exactly how the second one
		// gets missed. Any NEW ScalingSpec knob that stamps an annotation MUST be
		// explicitly dispositioned in the list above — forced, dropped, or
		// deliberately passed through — with an envtest asserting it.
		//
		// GATE (#775): the list above is no longer only prose. The scanning guard
		// in internal/controller/preview_annotation_disposition_test.go runs
		// buildDesiredKsvc production-vs-preview over SEVERAL admission-valid
		// NextApp shapes — maximal-with-warmSchedule, pinned-traffic (mutually
		// exclusive with the first, #393) and minimal, the last of which is what
		// reaches a stamp gated on a sub-spec being ABSENT. It requires every leaf
		// of NextAppSpec to be exercised by some fixture, every fixture to pass
		// validation.ValidateNextAppSpec, and every rendered knob — annotations by
		// prefix, RevisionSpec fields by reflection — to carry a disposition. Add a
		// knob here and the guard reds until you record the decision in both places.
		annotations["autoscaling.knative.dev/max-scale"] = "1"
		annotations["autoscaling.knative.dev/min-scale"] = "0"
		annotations["autoscaling.knative.dev/scale-to-zero-pod-retention-period"] = "30s"
		delete(annotations, "autoscaling.knative.dev/scale-down-delay")
	}

	envVars, envFrom, envMapCollision := r.buildKsvcEnv(nextApp)

	// readOnlyRootFilesystem (#1332): default-on, same posture as the
	// image-prewarm job container (image_prewarm.go) and the same
	// nil-means-true convention as the sibling NetworkPolicy field above.
	readOnlyRootFS := nextApp.Spec.Security == nil || nextApp.Spec.Security.ReadOnlyRootFilesystem == nil ||
		*nextApp.Spec.Security.ReadOnlyRootFilesystem
	// #1778: writableCache is nil-means-false (opt-IN), the opposite
	// convention from the other SecuritySpec bools — the default no longer
	// provisions the emptyDir.
	writableCache := nextApp.Spec.Security != nil && nextApp.Spec.Security.WritableCache != nil &&
		*nextApp.Spec.Security.WritableCache
	volumes, volumeMounts := buildWritableVolumes(nextApp, readOnlyRootFS, writableCache)

	// ContainerConcurrency default (#377, ADR-0028). Lowered from 100 → 20: a
	// pod absorbing 100 concurrent requests before Knative added a 2nd replica
	// made reactive scale-to-N effectively inert. 20 is the documented
	// high-traffic interim; W1 (#376) refines the exact value from the
	// concurrency→latency curve. Still overridable via
	// spec.scaling.containerConcurrency. NOTE: a lower cc scales apps to more
	// pods sooner, which raises DB connection pressure — the connection-wall
	// invariant (maxScale × poolMax ≤ max_connections) is enforced in
	// validation.ValidateNextAppSpec when a poolMax is declared.
	cc := eff.containerConcurrency

	// Resource limits — aligned with CLI defaults.
	//
	// #1778/#1786 round 2 (adversarial review): a 4000m default CPU LIMIT was
	// tried and REVERTED back to 1000m. The REQUEST stays 250m, so a 4000m
	// limit is a 16x request:limit ratio — a cluster with a LimitRange
	// capping `maxLimitRequestRatio` (a common value is 4) or a bare
	// `max.cpu` below 4 rejects the pod outright at admission
	// (`FailedCreate`), which is a silently-broken default deploy, not a
	// cold-start win. jev `pick` over keep-1000m / raise-to-2000m /
	// raise-to-4000m scored 0.89 / 0.10 / 0.01 — keep 1000m is the clear
	// choice once the LimitRange risk is in the comparison, even though
	// 4000m alone measured ~675ms faster on an unconstrained GKE
	// `e2-standard-4` (Holm p=0.0005,
	// docs/benchmarks/cold-start-gke-runtime-and-minimisation-2026-10-01.md).
	// The saving is real but NOT safe as a platform default; it ships as a
	// documented per-app recipe instead (raise spec.resources.cpuLimit, or
	// use a startup-CPU-boost controller) — see
	// docs/operator/scaling-cold-start.md. #1788 tracks the operator not
	// surfacing a LimitRange/quota FailedCreate in NextApp status, which is
	// what would make any higher default detectable instead of silent.
	//
	// The four values are the MERGED ones (app > platform > built-in, ADR-0064).
	// Every one is parsed with the BOUNDED parser whatever its source: an app value
	// comes from a CR and a platform value from an admin-authored one, and the
	// built-ins parse identically, so there is one path and no MustParse of
	// anything but a literal (the #635 scan enforces that).
	parseEffective := func(path string, v effectiveString) (resource.Quantity, error) {
		q, err := validation.ParseQuantityBounded(v.value)
		if err != nil {
			if v.src == sourcePlatform {
				return q, fmt.Errorf("KnextPlatform %s %q is not a valid Kubernetes quantity: %w", platformResourcePath(path), v.value, err)
			}
			return q, fmt.Errorf("%s %q is not a valid Kubernetes quantity: %w", path, v.value, err)
		}
		return q, nil
	}
	cpuRequestQ, err := parseEffective("spec.resources.cpuRequest", eff.cpuRequest)
	if err != nil {
		return envMapCollisionReport{}, err
	}
	memoryRequestQ, err := parseEffective("spec.resources.memoryRequest", eff.memoryRequest)
	if err != nil {
		return envMapCollisionReport{}, err
	}
	cpuLimitQ, err := parseEffective("spec.resources.cpuLimit", eff.cpuLimit)
	if err != nil {
		return envMapCollisionReport{}, err
	}
	memoryLimitQ, err := parseEffective("spec.resources.memoryLimit", eff.memoryLimit)
	if err != nil {
		return envMapCollisionReport{}, err
	}
	resourceRequests := corev1.ResourceList{
		corev1.ResourceCPU:    cpuRequestQ,
		corev1.ResourceMemory: memoryRequestQ,
	}
	resourceLimits := corev1.ResourceList{
		corev1.ResourceCPU:    cpuLimitQ,
		corev1.ResourceMemory: memoryLimitQ,
	}

	// TimeoutSeconds: default 300s when unset (matches knative-manifest.ts hardcoded value)
	timeoutSeconds := eff.timeoutSeconds

	// Container command, by artifact shape (spec.build, spec.selfContained):
	//   - "vinext": the app is ONE compiled executable and the image's own CMD
	//     runs it. Command stays nil — forcing `bun run server.js` here would
	//     CrashLoop, because that file does not exist in a single-exec image.
	//     Runtime is irrelevant to startup for this shape (bun is baked into
	//     the binary).
	//   - absent / "turbopack" / "webpack" with SelfContained: true (#1522,
	//     N2 follow-up #1457): the SAME property as vinext — the image is one
	//     compiled executable, no `.next/standalone` tree, no `node_modules`
	//     — reached via the standalone bundler instead. Command stays nil for
	//     the identical reason: there is no `server.js` in this image either.
	//     (The image still ships a compat `/app/server.js` shim that execs
	//     the binary — round-2 of #1519 — so an OLD operator that still forces
	//     this command boots correctly too; this branch just stops adding an
	//     unnecessary second process for an operator new enough to know
	//     better.)
	//   - absent / "turbopack" / "webpack", not self-contained: the Next
	//     standalone tree (#1219: "webpack" is a second spelling of the same
	//     shape, not a new branch — the check below is `!= "vinext"`, not
	//     `== "turbopack"`). Runtime "bun" execs `bun run server.js`;
	//     "node"/absent uses the image default.
	var containerCommand []string
	if nextApp.Spec.Build != lcVinext && !nextApp.Spec.SelfContained && nextApp.Spec.Runtime == "bun" {
		containerCommand = []string{"bun", "run", "server.js"}
	}

	ksvc.Spec.Template.Annotations = annotations

	// Skew protection (#93): stamp the deploy's BUILD_ID onto the revision
	// (pod) template as a label. Knative propagates template labels to every
	// Revision, so the CLI's deploy-time asset GC can resolve a live revision
	// back to its build-id (read-only) and never reap a live build's assets.
	if nextApp.Spec.BuildID != "" {
		if ksvc.Spec.Template.Labels == nil {
			ksvc.Spec.Template.Labels = make(map[string]string)
		}
		ksvc.Spec.Template.Labels[appsv1alpha1.BuildIDLabel] = nextApp.Spec.BuildID
	}

	ksvc.Spec.Template.Spec.ServiceAccountName = nextApp.Name + "-sa"
	ksvc.Spec.Template.Spec.ContainerConcurrency = &cc
	ksvc.Spec.Template.Spec.TimeoutSeconds = &timeoutSeconds
	ksvc.Spec.Template.Spec.Containers = []corev1.Container{
		{
			Image:        nextApp.Spec.Image,
			Command:      containerCommand,
			Env:          envVars,
			EnvFrom:      envFrom,
			VolumeMounts: volumeMounts,
			// Pod Security `restricted` by default; only runAsNonRoot has an
			// opt-out (spec.security.runAsNonRoot). See pod_hardening.go.
			SecurityContext: restrictedContainerSecurityContext(new(readOnlyRootFS), nextAppRunAsNonRoot(nextApp.Spec.Security)),
			Ports: []corev1.ContainerPort{
				{ContainerPort: 3000},
			},
			Resources: corev1.ResourceRequirements{
				Requests: resourceRequests,
				Limits:   resourceLimits,
			},
			// Readiness: HTTP GET on the SHALLOW health path (#338), stamped
			// KNATIVE-AGGRESSIVE — initialDelaySeconds and periodSeconds are
			// deliberately OMITTED (both 0).
			//
			// Knative treats periodSeconds == 0 as its special aggressive mode:
			// the queue-proxy retries the readiness probe sub-second instead of
			// on the kubelet's grid, so a revision goes Ready the moment the app
			// answers. Setting ANY explicit period opts the revision OUT of that
			// mode; an initialDelay blinds the probe entirely for its duration.
			//
			// Measured on OKE (probe-shape A/B, n=6 per arm, same image/env/data
			// plane): the previous {initialDelay: 2, period: 3} cost ~1.2s of
			// MEDIAN cold start (5723ms probed vs 4562ms unprobed). The signature
			// was grid quantization — the probed arm's container->Ready landed
			// ONLY on probe-grid values (2000/3000/5000ms), i.e. readiness was
			// gated by the probe clock, not by the app. The benchmark apps bypass
			// the operator, so no cold-start ledger row ever saw this tax.
			//
			// timeoutSeconds/failureThreshold stay unset because Knative's
			// revision validation REJECTS them when periodSeconds is zero
			// (knative.dev/serving/pkg/apis/serving/k8s_validation.go,
			// validateReadinessProbe: "failureThreshold is disallowed when
			// periodSeconds is zero", same for timeoutSeconds). successThreshold
			// is defaulted to 1 by Knative (revision_defaults.go).
			//
			// The handler stays httpGet, NOT tcpSocket: a TCP connect would go
			// Ready on a bound socket, dropping the health-path semantics.
			ReadinessProbe: &corev1.Probe{
				ProbeHandler: corev1.ProbeHandler{
					HTTPGet: &corev1.HTTPGetAction{
						Path: healthPath,
						Port: intstr.FromInt(3000),
					},
				},
			},
			// Liveness KEEPS an explicit delay + period, unlike readiness above.
			// Knative has no aggressive mode for liveness (it is enforced by the
			// kubelet against the user container, and periodSeconds == 0 there
			// just means "kubelet default"), and sub-second liveness probing
			// would restart-thrash a slow-booting container. Liveness is a
			// crash detector, not a cold-start gate: it costs nothing on the
			// path to Ready, so leave it conservative.
			LivenessProbe: &corev1.Probe{
				ProbeHandler: corev1.ProbeHandler{
					HTTPGet: &corev1.HTTPGetAction{
						Path: healthPath,
						Port: intstr.FromInt(3000),
					},
				},
				InitialDelaySeconds: 5,
				PeriodSeconds:       10,
			},
		},
	}
	ksvc.Spec.Template.Spec.Volumes = volumes

	// Traffic split (issue #92): render the rollback/canary intent from
	// spec.traffic. nil => clear any prior split so Knative reverts to
	// 100% latest-ready (no stale pin on transition back).
	ksvc.Spec.Traffic = buildTrafficTargets(nextApp)

	return envMapCollision, ctrl.SetControllerReference(nextApp, ksvc, r.Scheme)
}

// buildTrafficTargets renders the Knative Service spec.traffic block from the
// NextApp's spec.traffic intent (issue #92 — rollback / canary).
//
// Semantics:
//   - nil Traffic OR empty RevisionName => nil: emit no spec.traffic so Knative
//     defaults to 100% of the latest-ready revision (byte-identical to pre-#92).
//   - RevisionName set, CanaryPercent == 0 => one target: 100% to the pinned
//     revision (a full rollback).
//   - RevisionName set, CanaryPercent in 1..99 => two targets: (100-p)% to the
//     pinned revision + p% to the latest-ready revision (a canary back toward
//     latest). The sum is always 100.
func buildTrafficTargets(app *appsv1alpha1.NextApp) []servingv1.TrafficTarget {
	if app.Spec.Traffic == nil || app.Spec.Traffic.RevisionName == "" {
		return nil
	}
	t := app.Spec.Traffic
	canary := t.CanaryPercent
	if canary <= 0 || canary >= 100 {
		// Full pin: 100% to the named revision.
		return []servingv1.TrafficTarget{
			{
				RevisionName:   t.RevisionName,
				LatestRevision: new(false),
				Percent:        new(int64(100)),
			},
		}
	}
	// Canary: (100-p)% pinned, p% latest-ready.
	return []servingv1.TrafficTarget{
		{
			RevisionName:   t.RevisionName,
			LatestRevision: new(false),
			Percent:        new(int64(100 - canary)),
		},
		{
			LatestRevision: new(true),
			Percent:        new(int64(canary)),
		},
	}
}

// mapTrafficStatus mirrors the Knative Service's observed traffic distribution
// into NextApp.Status.CurrentTraffic, nil-safe on the *Percent / *LatestRevision
// pointers. Returns nil for an empty input so the status field stays omitted.
func mapTrafficStatus(targets []servingv1.TrafficTarget) []appsv1alpha1.TrafficStatus {
	if len(targets) == 0 {
		return nil
	}
	out := make([]appsv1alpha1.TrafficStatus, 0, len(targets))
	for _, t := range targets {
		ts := appsv1alpha1.TrafficStatus{RevisionName: t.RevisionName}
		if t.Percent != nil {
			ts.Percent = *t.Percent
		}
		if t.LatestRevision != nil {
			ts.LatestRevision = *t.LatestRevision
		}
		out = append(out, ts)
	}
	return out
}
