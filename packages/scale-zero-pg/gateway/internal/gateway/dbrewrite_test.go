package gateway

import (
	"testing"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
)

// In template (branch-per-app) mode the DSN database name is a LOGICAL routing
// handle: it selects the per-app compute/branch, but every app's branch serves
// the same physical database ("postgres", which carries the inherited template
// schema). So the gateway must replay the startup with database rewritten to the
// served DB while preserving every other param (user, application_name, ...).
func TestRewriteStartupDatabase(t *testing.T) {
	params := map[string]string{"user": "cloud_admin", "database": "alpha", "application_name": "knext"}
	orig := proto.BuildStartup(params)

	out := rewriteStartupDatabase(orig, params, "postgres")
	msg, err := proto.ParseInitialPacket(out)
	if err != nil {
		t.Fatalf("parse rewritten: %v", err)
	}
	if msg.Params["database"] != "postgres" {
		t.Fatalf("database = %q, want postgres", msg.Params["database"])
	}
	if msg.Params["user"] != "cloud_admin" || msg.Params["application_name"] != "knext" {
		t.Fatalf("other params not preserved: %+v", msg.Params)
	}

	// No served DB, or already equal → return the ORIGINAL bytes untouched
	// (static/kubectl modes must never have their startup rewritten).
	if got := rewriteStartupDatabase(orig, params, ""); &got[0] != &orig[0] {
		t.Fatalf("served=\"\" must return the original packet unchanged")
	}
	same := map[string]string{"user": "u", "database": "postgres"}
	sorig := proto.BuildStartup(same)
	if got := rewriteStartupDatabase(sorig, same, "postgres"); &got[0] != &sorig[0] {
		t.Fatalf("served==database must return the original packet unchanged")
	}
}
