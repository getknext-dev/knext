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
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Unit tests for the pure image-prewarm DaemonSet builder (ADR-0037). The
// builder must produce a DaemonSet that PULLS + PINS the app's digest-pinned
// image on every node WITHOUT booting the app server and WITHOUT assuming a
// shell in the (possibly distroless) app image — the distroless-safety
// invariant the ADR requires. The envtest reconcile lifecycle
// (image_prewarm_envtest_test.go) is the end-to-end net; these pin the pod
// shape at the pure seam.

func prewarmApp() *appsv1alpha1.NextApp {
	app := &appsv1alpha1.NextApp{}
	app.Name = "shop"
	app.Namespace = "prod"
	app.Spec.Image = "registry.example.com/shop@sha256:" + strings.Repeat("a", 64)
	app.Spec.Scaling = &appsv1alpha1.ScalingSpec{ImagePrewarm: true}
	return app
}

// TestPrewarmHelperImage_DigestPinned enforces the security hard rule (security.md /
// CLAUDE.md §7): every image the operator runs is pinned by digest, never a bare
// tag. The prewarm helper image is operator-owned, so it must be digest-pinned
// exactly like app images are — closing the one tag-pinned exception (#471). If a
// future edit drops the @sha256: digest back to a floating tag, this fails.
func TestPrewarmHelperImage_DigestPinned(t *testing.T) {
	if !strings.Contains(prewarmHelperImage, "@sha256:") {
		t.Fatalf("prewarmHelperImage %q must be digest-pinned (@sha256:...), not a floating tag — operator images are digest-pinned per security.md", prewarmHelperImage)
	}
	// The digest must be a full 64-hex sha256, not a truncated placeholder.
	idx := strings.Index(prewarmHelperImage, "@sha256:")
	digest := prewarmHelperImage[idx+len("@sha256:"):]
	if len(digest) != 64 {
		t.Fatalf("prewarmHelperImage digest %q must be 64 hex chars, got %d", digest, len(digest))
	}
}

// TestBuildImagePrewarmDaemonSet_InitContainerUsesDigestPinnedHelper asserts the
// built DaemonSet's initContainer actually consumes the digest-pinned constant
// (not some other reference).
func TestBuildImagePrewarmDaemonSet_InitContainerUsesDigestPinnedHelper(t *testing.T) {
	ds := buildImagePrewarmDaemonSet(prewarmApp(), nil)
	if len(ds.Spec.Template.Spec.InitContainers) == 0 {
		t.Fatal("expected an initContainer staging the helper binary")
	}
	got := ds.Spec.Template.Spec.InitContainers[0].Image
	if !strings.Contains(got, "@sha256:") {
		t.Fatalf("initContainer helper image %q must be digest-pinned", got)
	}
	if got != prewarmHelperImage {
		t.Fatalf("initContainer image %q must be the pinned prewarmHelperImage %q", got, prewarmHelperImage)
	}
}

func TestBuildImagePrewarmDaemonSet_NameAndImage(t *testing.T) {
	app := prewarmApp()
	ds := buildImagePrewarmDaemonSet(app, nil)

	if ds.Name != "shop-imgcache" {
		t.Fatalf("name: got %q, want shop-imgcache", ds.Name)
	}
	if ds.Namespace != "prod" {
		t.Fatalf("namespace: got %q, want prod", ds.Namespace)
	}

	main := mainPrewarmContainer(t, ds)
	// The MAIN container must run the app's exact digest-pinned image so kubelet
	// pulls that digest and a running container references it (containerd GC
	// cannot evict an image a running container uses).
	if main.Image != app.Spec.Image {
		t.Fatalf("main container image: got %q, want app image %q", main.Image, app.Spec.Image)
	}
}

func TestBuildImagePrewarmDaemonSet_MainCommandIsNotAppEntrypoint(t *testing.T) {
	app := prewarmApp()
	ds := buildImagePrewarmDaemonSet(app, nil)
	main := mainPrewarmContainer(t, ds)

	// DISTROLESS-SAFETY INVARIANT (ADR-0037): the main container must NOT boot
	// the app server. Its command must point at the static helper binary copied
	// into the shared emptyDir by the initContainer — never inherit the app
	// image's own entrypoint/command, and never assume /bin/sh exists.
	if len(main.Command) == 0 {
		t.Fatalf("main container has no explicit command — it would inherit the app entrypoint and BOOT the app server (distroless-unsafe)")
	}
	if !strings.HasPrefix(main.Command[0], prewarmHelperMountPath+"/") {
		t.Fatalf("main command %v must exec the copied helper under %q, not the app entrypoint", main.Command, prewarmHelperMountPath)
	}
	// Must not be a shell invocation (distroless images have no /bin/sh).
	for _, tok := range main.Command {
		if tok == "/bin/sh" || tok == "sh" || tok == "/bin/bash" || tok == "bash" {
			t.Fatalf("main command %v assumes a shell — distroless app images have none (CrashLoopBackOff)", main.Command)
		}
	}
}

func TestBuildImagePrewarmDaemonSet_InitContainerCopiesHelper(t *testing.T) {
	app := prewarmApp()
	ds := buildImagePrewarmDaemonSet(app, nil)

	inits := ds.Spec.Template.Spec.InitContainers
	if len(inits) != 1 {
		t.Fatalf("want exactly 1 initContainer that stages the static helper, got %d", len(inits))
	}
	init := inits[0]
	// The initContainer must NOT use the app image — it uses a helper image that
	// is guaranteed to carry a static binary, then copies it into the emptyDir.
	if init.Image == app.Spec.Image {
		t.Fatalf("initContainer must use the helper image, not the app image")
	}
	// It must write into the shared emptyDir mount.
	if !containerMountsPath(init, prewarmHelperMountPath) {
		t.Fatalf("initContainer must mount the shared helper emptyDir at %q", prewarmHelperMountPath)
	}
	main := mainPrewarmContainer(t, ds)
	if !containerMountsPath(main, prewarmHelperMountPath) {
		t.Fatalf("main container must mount the shared helper emptyDir at %q to exec the copied binary", prewarmHelperMountPath)
	}
	// The shared volume must be an emptyDir.
	found := false
	for _, vol := range ds.Spec.Template.Spec.Volumes {
		if vol.EmptyDir != nil {
			found = true
		}
	}
	if !found {
		t.Fatalf("want an emptyDir volume shared between init and main containers")
	}
}

func TestBuildImagePrewarmDaemonSet_Security(t *testing.T) {
	app := prewarmApp()
	ds := buildImagePrewarmDaemonSet(app, nil)
	spec := ds.Spec.Template.Spec

	if spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken {
		t.Fatalf("automountServiceAccountToken must be false")
	}
	if spec.SecurityContext == nil || spec.SecurityContext.SeccompProfile == nil ||
		spec.SecurityContext.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Fatalf("pod securityContext must set seccompProfile RuntimeDefault")
	}

	main := mainPrewarmContainer(t, ds)
	if main.SecurityContext == nil {
		t.Fatalf("main container has no securityContext")
	}
	sc := main.SecurityContext
	if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Fatalf("main container must runAsNonRoot")
	}
	if sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem {
		t.Fatalf("main container must set readOnlyRootFilesystem: true")
	}
	if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Fatalf("main container must set allowPrivilegeEscalation: false")
	}

	// Tiny requests so the prewarmer does not steal schedulable capacity.
	req := main.Resources.Requests
	if req.Cpu().String() != "1m" {
		t.Fatalf("cpu request: got %q, want 1m", req.Cpu().String())
	}
	if req.Memory().String() != "16Mi" {
		t.Fatalf("memory request: got %q, want 16Mi", req.Memory().String())
	}

	// Must tolerate every taint so it caches on tainted nodes too.
	tolerateAll := false
	for _, tol := range spec.Tolerations {
		if tol.Operator == corev1.TolerationOpExists && tol.Key == "" {
			tolerateAll = true
		}
	}
	if !tolerateAll {
		t.Fatalf("want a blanket {operator: Exists} toleration so it caches on tainted nodes")
	}
}

func TestBuildImagePrewarmDaemonSet_PullSecretsThreaded(t *testing.T) {
	app := prewarmApp()
	pull := []corev1.LocalObjectReference{{Name: "ocir-creds"}}
	ds := buildImagePrewarmDaemonSet(app, pull)

	got := ds.Spec.Template.Spec.ImagePullSecrets
	if len(got) != 1 || got[0].Name != "ocir-creds" {
		t.Fatalf("imagePullSecrets: got %+v, want [ocir-creds]", got)
	}
}

// mainPrewarmContainer returns the single non-init ("main") container — the one
// that runs the APP IMAGE to pin the digest resident on the node.
func mainPrewarmContainer(t *testing.T, ds *appsv1.DaemonSet) corev1.Container {
	t.Helper()
	cs := ds.Spec.Template.Spec.Containers
	if len(cs) != 1 {
		t.Fatalf("want exactly 1 main container, got %d", len(cs))
	}
	return cs[0]
}

func containerMountsPath(c corev1.Container, path string) bool {
	for _, m := range c.VolumeMounts {
		if m.MountPath == path {
			return true
		}
	}
	return false
}
