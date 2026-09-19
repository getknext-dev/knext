package appdb

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/yaml"
)

// F5 phase 2 (ADR-0003) gave the per-app compute its server cert + CA so it can
// OFFER TLS; phase 4 then enforces `hostssl … clientcert=verify-ca` — but ONLY
// when the compute is actually serving TLS (`SHOW ssl = on`). Those two Secrets
// reach the compute purely by being MOUNTED: config.json's ssl_* GUCs point at
// /etc/pggw-compute-server-tls + /etc/pggw-mtls-ca, and the entrypoint STRIPS
// every ssl GUC (booting plaintext) when the files are absent. So a per-app
// compute rendered WITHOUT these mounts boots ssl=off and phase-4 enforcement
// silently never engages.
//
// The template (deploy/compute-app.template.yaml) carries the mounts, but the
// operator renders per-app computes from render.go, and the existing
// template-parity guard compares ENV NAMES only — it is blind to volume/mount
// drift, which is exactly how this gap shipped: F5-closed on static checks,
// unenforced on every operator-provisioned per-app database (found by live GKE
// verification, 2026-09-19). These guards close that blind spot.

const (
	serverTLSSecret = "pggw-compute-server-tls"
	mtlsCASecret    = "pggw-mtls-ca"
	serverTLSMount  = "/etc/pggw-compute-server-tls"
	mtlsCAMount     = "/etc/pggw-mtls-ca"
)

func volNames(vols []corev1.Volume) map[string]corev1.Volume {
	m := make(map[string]corev1.Volume, len(vols))
	for _, v := range vols {
		m[v.Name] = v
	}
	return m
}

func mountPaths(cs []corev1.Container) map[string]string {
	m := map[string]string{}
	for _, c := range cs {
		for _, vm := range c.VolumeMounts {
			m[vm.Name] = vm.MountPath
		}
	}
	return m
}

// assertBackendTLSMounted checks a rendered compute pod spec carries BOTH phase-1
// Secrets, mounted where config.json's ssl_* GUCs expect them, with the CA
// projected ca.crt-only (its private key must never reach a compute pod).
func assertBackendTLSMounted(t *testing.T, ps corev1.PodSpec, who string) {
	t.Helper()
	mp := mountPaths(ps.Containers)
	if mp[serverTLSSecret] != serverTLSMount {
		t.Errorf("%s: server cert not mounted at %s (got %q) — the compute cannot offer TLS, so phase-4 mTLS never enforces", who, serverTLSMount, mp[serverTLSSecret])
	}
	if mp[mtlsCASecret] != mtlsCAMount {
		t.Errorf("%s: CA not mounted at %s (got %q)", who, mtlsCAMount, mp[mtlsCASecret])
	}
	vols := volNames(ps.Volumes)
	sv, ok := vols[serverTLSSecret]
	if !ok || sv.Secret == nil || sv.Secret.SecretName != serverTLSSecret {
		t.Errorf("%s: volume %q must be a Secret volume for %q", who, serverTLSSecret, serverTLSSecret)
	} else if sv.Secret.Optional == nil || !*sv.Secret.Optional {
		t.Errorf("%s: server-tls volume must be optional:true (a certless dev cluster still schedules; the entrypoint strips ssl -> plaintext)", who)
	}
	ca, ok := vols[mtlsCASecret]
	if !ok || ca.Secret == nil || ca.Secret.SecretName != mtlsCASecret {
		t.Errorf("%s: volume %q must be a Secret volume for %q", who, mtlsCASecret, mtlsCASecret)
	} else {
		if ca.Secret.Optional == nil || !*ca.Secret.Optional {
			t.Errorf("%s: mtls-ca volume must be optional:true", who)
		}
		// ca.crt ONLY — never the CA private key.
		if len(ca.Secret.Items) != 1 || ca.Secret.Items[0].Key != "ca.crt" {
			t.Errorf("%s: mtls-ca volume must project ca.crt ONLY (the CA private key must not reach a compute pod), got items=%v", who, ca.Secret.Items)
		}
	}
}

// The operator-provisioned per-app WRITER must serve TLS.
func TestRenderDeploymentMountsBackendTLS(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderDeployment(ComputeSpec{App: "tlsparity", TenantID: "t", TimelineID: "l"})
	assertBackendTLSMounted(t, dep.Spec.Template.Spec, "RenderDeployment (per-app writer)")
}

// The per-app READ REPLICA is dialled by the gateway just like the writer, so it
// must serve TLS too (the static 26-compute-ro carries the mounts; the operator
// render path must match).
func TestRenderRODeploymentMountsBackendTLS(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderRODeployment(ROComputeSpec{App: "tlsparity", TenantID: "t", TimelineID: "l"})
	assertBackendTLSMounted(t, dep.Spec.Template.Spec, "RenderRODeployment (per-app reader)")
}

// General guard: every VOLUME and VOLUMEMOUNT name the template's per-app compute
// carries must also be rendered by RenderDeployment. The existing parity guard
// compares env names only; this extends the same "render.go mirrors the template"
// claim to volumes, so the next volume added to the template cannot silently skip
// the operator path.
func TestRenderDeploymentMatchesTemplateVolumes(t *testing.T) {
	tmplVols, tmplMounts := templateComputeVolumeNames(t)
	if len(tmplVols) == 0 || len(tmplMounts) == 0 {
		t.Fatal("parsed no volumes/mounts from the template — the guard would pass vacuously")
	}
	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderDeployment(ComputeSpec{App: "parity", TenantID: "t", TimelineID: "l"})
	ps := dep.Spec.Template.Spec

	goVols := make([]string, 0)
	for n := range volNames(ps.Volumes) {
		goVols = append(goVols, n)
	}
	goMounts := make([]string, 0)
	// Compare BOTH init + app containers on the Go side too, symmetric with
	// templateComputeVolumeNames — otherwise an init-container mount added to both
	// the template and render.go would false-positive (red a correct change).
	for n := range mountPaths(append(append([]corev1.Container{}, ps.InitContainers...), ps.Containers...)) {
		goMounts = append(goMounts, n)
	}
	if miss := difference(tmplVols, goVols); len(miss) > 0 {
		t.Errorf("the template declares volumes the Go renderer does not: %v — render.go claims to mirror the template; a per-app compute the operator provisions would miss them", miss)
	}
	if miss := difference(tmplMounts, goMounts); len(miss) > 0 {
		t.Errorf("the template mounts volumes the Go renderer does not: %v", miss)
	}
}

// templateComputeVolumeNames extracts volume names + container volumeMount names
// from the template's per-app compute Deployment (the cert mounts are literal, so
// a plain unmarshal works; a Deployment that fails to parse fails loudly).
func templateComputeVolumeNames(t *testing.T) (vols []string, mounts []string) {
	t.Helper()
	path := filepath.Join("..", "..", "..", "deploy", "compute-app.template.yaml")
	rawBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read the template (%s): %v", path, err)
	}
	raw := strings.ReplaceAll(string(rawBytes), "__APP__", "parity")
	for _, doc := range strings.Split(raw, "\n---") {
		type ctr struct {
			VolumeMounts []struct {
				Name string `json:"name"`
			} `json:"volumeMounts"`
		}
		var obj2 struct {
			Kind string `json:"kind"`
			Spec struct {
				Template struct {
					Spec struct {
						Containers     []ctr `json:"containers"`
						InitContainers []ctr `json:"initContainers"`
						Volumes        []struct {
							Name string `json:"name"`
						} `json:"volumes"`
					} `json:"spec"`
				} `json:"template"`
			} `json:"spec"`
		}
		if err := yaml.Unmarshal([]byte(doc), &obj2); err != nil {
			if strings.Contains(doc, "kind: Deployment") {
				t.Fatalf("the template's Deployment did not parse, so the expected volume set would be silently short: %v", err)
			}
			continue
		}
		if obj2.Kind != "Deployment" {
			continue
		}
		for _, v := range obj2.Spec.Template.Spec.Volumes {
			vols = append(vols, v.Name)
		}
		// BOTH init and app containers — an initContainer volume drift is just as
		// silent as an app-container one (a wait-timeline init that grows a mount
		// the operator does not render would be invisible to a containers-only scan).
		for _, cont := range append(obj2.Spec.Template.Spec.InitContainers, obj2.Spec.Template.Spec.Containers...) {
			for _, vm := range cont.VolumeMounts {
				mounts = append(mounts, vm.Name)
			}
		}
	}
	return vols, mounts
}

// KNOWN BLIND SPOT (recorded, not closed): the general volume-parity test above
// compares RenderDeployment (the per-app WRITER) against compute-app.template.yaml
// only. RenderRODeployment (the per-app READER) has no dedicated template to diff
// against — the only RO manifest, deploy/26-compute-ro.yaml, is the BASE tier and
// legitimately differs (different credential, RO_MODE, ro-lsn), so a strict
// name-parity there would false-positive. The F5 mount is guarded directly by
// TestRenderRODeploymentMountsBackendTLS; a FUTURE volume added to the RO static
// manifest could still skip the operator RO render silently. Closing this needs a
// curated allowlist of the legitimate base-vs-per-app differences, deferred.
