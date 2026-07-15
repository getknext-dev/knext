package appdb

import (
	"testing"
)

// issue #117 (md5 -> SCRAM): the writer compute receives the app role's SCRAM-SHA-256
// VERIFIER (non-reversible) via env from the per-app Secret, and compute_ctl injects it
// verbatim into the spec so the role is SCRAM from boot. Crucially there is NO tenant
// plaintext delivered to the compute at all — no plaintext env var AND no plaintext
// file mount. This locks that contract so a refactor can't reintroduce plaintext.
func TestRenderDeploymentInjectsScramVerifierNoPlaintext(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderDeployment(ComputeSpec{App: "shop", TenantID: "tx", TimelineID: "ty"})
	ctr := dep.Spec.Template.Spec.Containers[0]

	// 1. APP_ROLE_VERIFIER env, sourced from the app's Secret (optional).
	found := false
	for _, e := range ctr.Env {
		if e.Name == "APP_ROLE_VERIFIER" {
			found = true
			ref := e.ValueFrom.SecretKeyRef
			if ref == nil || ref.Name != "app-db-shop" || ref.Key != "APP_ROLE_VERIFIER" ||
				ref.Optional == nil || !*ref.Optional {
				t.Errorf("APP_ROLE_VERIFIER must come from Secret app-db-shop key APP_ROLE_VERIFIER (optional): %+v", e)
			}
		}
		// 2. NO plaintext ever reaches the compute (neither of these may appear).
		if e.Name == "APP_ROLE_PASSWORD" || e.Name == "PGPASSWORD" {
			t.Errorf("no tenant plaintext env may be injected: %s", e.Name)
		}
		// The old md5 key must be gone (renamed).
		if e.Name == "APP_ROLE_MD5" {
			t.Errorf("APP_ROLE_MD5 env must be renamed to APP_ROLE_VERIFIER (#117)")
		}
	}
	if !found {
		t.Fatalf("APP_ROLE_VERIFIER env not injected: %+v", ctr.Env)
	}

	// 3. No plaintext FILE mount either (the pivot removed the file-mount + fsGroup).
	for _, m := range ctr.VolumeMounts {
		if m.Name == "app-role-secret" {
			t.Errorf("app-role-secret plaintext file mount must be removed (verifier-in-spec needs no plaintext) (#117)")
		}
	}
	for _, v := range dep.Spec.Template.Spec.Volumes {
		if v.Name == "app-role-secret" {
			t.Errorf("app-role-secret volume must be removed (#117)")
		}
	}
}
