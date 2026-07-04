package wake

// ro.go — the read-only pool routing lane (issue #66).
//
// The gateway serves TWO DSNs with ZERO SQL parsing: the writer DSN
// (DATABASE_URL) routes to the single primary compute; the read-only DSN
// (DATABASE_URL_RO) routes to a separate pool of read-only computes. The RO
// lane is just a second Gateway built from an env whose GW_RO_* knobs are
// remapped onto a plain kubectl driver — so it reuses the exact same wake,
// idle, peer-aware sleep, and TLS machinery as the writer. No single-writer
// ceremony: RO computes attach read-only (mode Replica/Static) and coordinate
// nothing.
//
// GW_RO_PORT (read by main, not here) gates whether the RO lane exists at all.

// ROEnv derives the read-only pool's driver config from the base env by
// remapping the GW_RO_* knobs onto the generic GW_* keys a kubectl driver
// reads. The returned env is a copy; the base is never mutated (so the writer
// lane keeps its own GW_IDLE_MS etc).
//
//	GW_RO_DEPLOYMENT     -> GW_K8S_DEPLOYMENT   (default "compute-ro")
//	GW_RO_TARGET         -> GW_TARGET           (default <dep>.<ns>.svc:55432)
//	GW_RO_WAKE_REPLICAS  -> GW_WAKE_REPLICAS    (default "1"; HPA takes it past this)
//	GW_RO_IDLE_MS        -> GW_IDLE_MS          (default: inherit the writer's)
//
// TLS (GW_TLS_*), timeouts (GW_CONNECT/WAKE/RETRY_MS), namespace
// (GW_K8S_NAMESPACE) and GW_MAX_CONNS pass through unchanged, so the RO port
// gets the same front-door hardening as the writer port.
func ROEnv(base Env) Env {
	out := Env{}
	for k, v := range base {
		out[k] = v
	}
	out["GW_COMPUTE_MODE"] = "kubectl"

	dep := base.get("GW_RO_DEPLOYMENT", "compute-ro")
	out["GW_K8S_DEPLOYMENT"] = dep

	// Force the RO target; never inherit the writer's GW_TARGET. Empty lets
	// MakeDriver default to <dep>.<ns>.svc:55432.
	out["GW_TARGET"] = base.get("GW_RO_TARGET", "")

	out["GW_WAKE_REPLICAS"] = base.get("GW_RO_WAKE_REPLICAS", "1")

	if v := base.get("GW_RO_IDLE_MS", ""); v != "" {
		out["GW_IDLE_MS"] = v
	}
	return out
}
