package pswatcher

import (
	"regexp"
	"strings"
	"testing"
)

// #1100 review (FIX 4) — guard the DRILL, not just the controller.
//
// The on-cluster restart-idempotency check is the only proof that a RESUMED watcher
// converges a real plane. Its first shape restarted pswatcher on an ALREADY-converged
// plane and then waited for a predicate that was already true and stayed true even if
// convergeFailover were deleted — green by construction, i.e. decorative. A drill can
// silently regress to that shape with every unit test still passing, so the SHAPE is
// scanned here: the block must (1) stop the watcher, (2) STRAND the plane by advancing
// the ledger with the watcher down, (3) prove the strand is observable, and (4) wait on
// a predicate that checks each tenant's GENERATION, not merely its reachability.
//
// Mutation-prove: delete the ledger-advance (strand), or point the wait loop back at
// the reachability-only predicate → red.
func TestRestartIdempotencyDrillStrandsBeforeItAssertsReconvergence(t *testing.T) {
	drill := readFile(t, deployDir+"/_verify-failover-multitenant.sh")

	start := strings.Index(drill, `if [ "$RUN_RESTART_IDEMPOTENCY" = "1" ]; then`)
	if start < 0 {
		t.Fatal("the restart-idempotency block is gone from _verify-failover-multitenant.sh — the only on-cluster proof that a RESUMED watcher converges")
	}
	block := drill[start:]
	if end := strings.Index(block, "\nCONVERGED_AT="); end > 0 {
		block = block[:end]
	}

	checks := []struct {
		what string
		re   *regexp.Regexp
		why  string
	}{
		{
			what: "stops the watcher before stranding",
			re:   regexp.MustCompile(`scale deploy/pswatcher --replicas=0`),
			why:  "a RUNNING watcher converges the strand before the restart, so the restart would again be asserted against an already-correct plane",
		},
		{
			what: "strands the plane by advancing the ledger while the watcher is down",
			re:   regexp.MustCompile(`(?s)patch configmap "\$GEN_CM".{0,200}\$STRANDED_GEN`),
			why:  "without an actual strand the re-convergence assertion is true before the restart and cannot fail — the decorative shape this guard exists to prevent",
		},
		{
			what: "proves the strand is OBSERVABLE before asserting on it",
			re:   regexp.MustCompile(`STRAND_OK`),
			why:  "if no tenant is observed below the ledger, a green result proves nothing; the drill must report it as unasserted instead",
		},
		{
			what: "waits on a predicate that checks each tenant's GENERATION",
			re:   regexp.MustCompile(`t6_reconverged && \{ RECONVERGED=1`),
			why:  "reachability alone (t6_converged) is satisfied by a tenant still sitting at the OLD generation — exactly the stranded state the drill must detect",
		},
		{
			what: "still asserts NO second ledger advance",
			re:   regexp.MustCompile(`DOUBLE GENERATION ADVANCE`),
			why:  "the single-writer invariant: converge re-promotes at the SAME generation and never writes the ledger",
		},
	}
	for _, c := range checks {
		if !c.re.MatchString(block) {
			t.Errorf("restart-idempotency drill no longer %s (missing %s) — %s", c.what, c.re, c.why)
		}
	}

	// The generation-checking predicate must itself compare against the ledger
	// generation through the ROUTED vantage; a predicate that only calls t6_converged
	// is the decorative shape by another name.
	pred := regexp.MustCompile(`(?s)t6_reconverged\(\) \{.*?SVC_GEN.*?-ge "\$STRANDED_GEN".*?\}`)
	if !pred.MatchString(block) {
		t.Error("t6_reconverged no longer compares each tenant's routed-vantage generation against the ledger generation — it would go green on a stranded-but-reachable tenant")
	}
	// And the vantage helper it depends on must still exist.
	if !strings.Contains(drill, "SVC_GEN() {") {
		t.Error("SVC_GEN (read a tenant's generation through the routed Service) is gone — the drill can no longer tell 'converged' from 'reachable but stranded'")
	}
}
