package pswatcher

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// D4 (ADR-0010 §4) — the generation ledger's write contract: a resourceVersion CAS on
// every ledger write, and reserve-before-promote in failover(). D6 lands with it because
// the abort-after-partial-promotion path CHANGES SHAPE under the reserve-first inversion.
//
// The threat model (why a lease-free, replicas:1, Recreate singleton still needs a CAS):
// Recreate guarantees single-writer against a ROLLOUT, not against a node PARTITION. A
// node goes unreachable → its pswatcher is stuck Terminating → the standard remediation
// force-deletes the Node object → the API force-deletes the pod and a NEW pswatcher starts
// WHILE the old one may still run on the isolated kubelet. That is the only two-writers
// scenario, and it is exactly the scenario where both try to fail over. A merge-patch with
// no CAS lets the loser clobber a higher write; the CAS makes the loser abort instead.

// casClientset returns a fake clientset whose ConfigMap Update models the apiserver's
// optimistic concurrency: it REJECTS an update whose ResourceVersion does not match the
// stored object's (a Conflict) and BUMPS the ResourceVersion on every accepted write. The
// stock fake does neither — it leaves ResourceVersion untouched — so without this a CAS
// can never be exercised (proven by a probe: create/update both leave rv=""). The seed CM
// carries an explicit starting ResourceVersion so a stale-rv read is observable.
func casClientset(gen, startRV string) *fake.Clientset {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "pageserver-generation", Namespace: testNS, ResourceVersion: startRV},
		Data:       map[string]string{genKeyDefault: gen},
	}
	cs := fake.NewClientset(cm)
	cmGVR := schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
	next, _ := strconv.Atoi(startRV)
	cs.PrependReactor("update", "configmaps", func(action k8stesting.Action) (bool, runtime.Object, error) {
		ua := action.(k8stesting.UpdateAction)
		obj := ua.GetObject().(*corev1.ConfigMap)
		cur, err := cs.Tracker().Get(cmGVR, testNS, obj.Name)
		if err != nil {
			return false, nil, err
		}
		curCM := cur.(*corev1.ConfigMap)
		if obj.ResourceVersion != curCM.ResourceVersion {
			return true, nil, apierrors.NewConflict(schema.GroupResource{Resource: "configmaps"}, obj.Name,
				fmt.Errorf("resourceVersion %q does not match %q", obj.ResourceVersion, curCM.ResourceVersion))
		}
		next++
		obj = obj.DeepCopy()
		obj.ResourceVersion = strconv.Itoa(next)
		if terr := cs.Tracker().Update(cmGVR, obj, testNS); terr != nil {
			return true, nil, terr
		}
		return true, obj, nil
	})
	return cs
}

func casK8sClient(cs *fake.Clientset) *K8sClient {
	return &K8sClient{cs: cs, namespace: testNS, genConfigMap: "pageserver-generation", genKey: genKeyDefault}
}

// (a) Two concurrent writers on the REAL K8sClient: the winner advances the ledger; the
// loser, holding the pre-winner resourceVersion, gets ErrLedgerConflict and DOES NOT
// clobber the winner's higher value.
func TestSetGenerationCASConflictDoesNotClobber(t *testing.T) {
	k := casK8sClient(casClientset("5", "1000"))
	ctx := context.Background()

	// Both writers read the same starting resourceVersion.
	gen, ok, rv, err := k.GetGeneration(ctx)
	if err != nil || !ok || gen != 5 {
		t.Fatalf("GetGeneration = (%d,%v,%q,%v), want (5,true,<rv>,nil)", gen, ok, rv, err)
	}
	if rv == "" {
		t.Fatal("GetGeneration must return the ConfigMap resourceVersion as the CAS token")
	}

	// WINNER: advances 5 -> 6 at the shared rv. Succeeds and moves the resourceVersion.
	if werr := k.SetGeneration(ctx, 6, rv); werr != nil {
		t.Fatalf("winner SetGeneration(6) must succeed: %v", werr)
	}

	// LOSER: still holds the STALE pre-winner rv and tries to write 7. It must be rejected
	// as an ErrLedgerConflict and must NOT overwrite the winner's 6 with a (here higher,
	// but the point is UNCOORDINATED) value.
	lerr := k.SetGeneration(ctx, 7, rv)
	if !errors.Is(lerr, ErrLedgerConflict) {
		t.Fatalf("loser SetGeneration at a stale rv must return ErrLedgerConflict, got %v", lerr)
	}
	final, _, _, err := k.GetGeneration(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if final != 6 {
		t.Fatalf("ledger must hold the winner's 6, not the loser's clobber: got %d", final)
	}
}

// (b) reserve-before-promote ordering, negative case: when the CAS-reserve LOSES, the
// failover aborts WITHOUT promoting any tenant and WITHOUT flipping the Service, and the
// loss is counted (the loud signal that two writers contended). A loser that had already
// PUT tenants at newGen before discovering the loss is precisely the split-brain the
// inversion removes.
func TestFailoverAbortsOnLostReserveCASWithoutPromoting(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	// The ledger write loses its CAS (a concurrent writer advanced it first).
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true, genRV: "77",
		primaryPresent: true, primaryReady: false,
		setGenErr: ErrLedgerConflict,
	}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})

	fo, err := c.Tick(context.Background())
	if err == nil {
		t.Fatal("a lost reserve CAS must surface an error (abort the tick), got nil")
	}
	if !errors.Is(err, ErrLedgerConflict) {
		t.Fatalf("the abort must carry ErrLedgerConflict, got %v", err)
	}
	if fo {
		t.Fatal("must not report a completed failover when the reserve CAS was lost")
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("NO tenant may be promoted after a lost reserve CAS (reserve precedes promote): %v", promoter.calls)
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("the Service must NOT flip after a lost reserve CAS: %v", k8s.flippedTo)
	}
	if c.Metrics().LedgerCASConflicts() != 1 {
		t.Fatalf("a lost reserve CAS must be counted once, got %d", c.Metrics().LedgerCASConflicts())
	}
}

// reserveOrderPromoter records the ledger value observed at the moment of each Promote,
// proving the reserve happened BEFORE the promote (the ledger already carries newGen).
type reserveOrderPromoter struct {
	k8s       *fakeK8s
	ledgerAt  map[string]int // ledger gen seen when each tenant was promoted
	perTenant map[string][]int
}

func (p *reserveOrderPromoter) Promote(_ context.Context, tenant string, gen int) error {
	if p.ledgerAt == nil {
		p.ledgerAt = map[string]int{}
		p.perTenant = map[string][]int{}
	}
	p.ledgerAt[tenant] = p.k8s.gen // the ledger as it stands when this PUT runs
	p.perTenant[tenant] = append(p.perTenant[tenant], gen)
	return nil
}

// (b, positive) reserve-before-promote ordering, happy path: every Promote observes the
// ledger ALREADY reserved at newGen — the inversion, proven directly rather than inferred.
func TestFailoverReservesLedgerBeforeAnyPromote(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 4, genSet: true, genRV: "12",
		primaryPresent: true, primaryReady: false,
	}
	promoter := &reserveOrderPromoter{k8s: k8s}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})

	fo, err := c.Tick(context.Background())
	if err != nil || !fo {
		t.Fatalf("failover must complete: fo=%v err=%v", fo, err)
	}
	for _, tenant := range []string{"f0f0-base", "a000-apps"} {
		if p := promoter.perTenant[tenant]; len(p) != 1 || p[0] != 5 {
			t.Fatalf("%s promoted %v, want [5]", tenant, p)
		}
		if got := promoter.ledgerAt[tenant]; got != 5 {
			t.Fatalf("%s was promoted while the ledger read %d — the reserve must precede the promote (want 5)", tenant, got)
		}
	}
	if len(k8s.setGenTo) != 1 || k8s.setGenTo[0] != 5 {
		t.Fatalf("ledger reserved exactly once at 5: %v", k8s.setGenTo)
	}
	if len(k8s.setGenRVs) != 1 || k8s.setGenRVs[0] != "12" {
		t.Fatalf("the reserve must CAS against the rv read this tick (12): %v", k8s.setGenRVs)
	}
}

// (c/D6) abort-AFTER-partial-promotion, then the primary returns fenced and the plane
// converges with a SINGLE generation advance across the whole episode. The reliability
// sprint never covered this path; the reserve-first inversion is exactly what makes it
// safe — a partial promotion that aborts leaves the ledger reserved AHEAD (the self-healing
// skew), and the in-instance reserved-generation resume re-promotes at the SAME generation
// rather than advancing again on every retry.
func TestFailoverAbortsMidRoutedSetThenConvergesSingleAdvance(t *testing.T) {
	primary := &toggleProber{alive: false} // stays down: a returned-but-FENCED primary fails its probe
	standby := &toggleProber{alive: true}
	// The apps tenant's PUT fails on the FIRST failover attempt (a long partition on the
	// apps timeline), then succeeds — the base is already PUT at newGen when it aborts.
	promoter := &fakePromoter{hardErr: map[string]bool{"a000-apps": true}}
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true, genRV: "1",
		primaryPresent: true, primaryReady: false, // present (returned) but not ready (fenced)
	}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})

	// --- Tick 1: reserve gen2, promote base@2, apps@2 FAILS → abort mid-routed-set.
	fo, err := c.Tick(context.Background())
	if err == nil || fo {
		t.Fatalf("tick 1 must abort mid-routed-set (fo=%v err=%v)", fo, err)
	}
	if len(k8s.setGenTo) != 1 || k8s.setGenTo[0] != 2 {
		t.Fatalf("the ledger must be RESERVED once at 2 before the partial promotion: %v", k8s.setGenTo)
	}
	if got := promoter.perTenant["f0f0-base"]; len(got) != 1 || got[0] != 2 {
		t.Fatalf("the base tenant must have been PUT at 2 before the abort: %v", got)
	}
	if got := promoter.perTenant["a000-apps"]; len(got) != 0 {
		t.Fatalf("the apps tenant must NOT be recorded promoted (its PUT failed): %v", got)
	}
	// The FENCING danger state, now proven: the ledger + base sit at gen2 (standby side)
	// while the Service still routes to the returned primary, which holds the LOWER gen1
	// and is therefore fenced. The loop must not have flipped yet.
	if len(k8s.flippedTo) != 0 || k8s.selectorApp != "pageserver" {
		t.Fatalf("the Service must still route to the (fenced) primary after the abort: sel=%q flips=%v", k8s.selectorApp, k8s.flippedTo)
	}
	if c.reservedGen != 2 {
		t.Fatalf("this instance must hold reservedGen=2 to resume at the SAME generation, got %d", c.reservedGen)
	}

	// The apps tenant's partition heals (its PUT will now succeed).
	promoter.hardErr = nil

	// --- Tick 2: resume at the RESERVED gen2 (no second advance), promote both, flip.
	fo, err = c.Tick(context.Background())
	if err != nil {
		t.Fatalf("tick 2 must converge cleanly: %v", err)
	}
	if !fo {
		t.Fatal("tick 2 must complete the failover")
	}
	if got := promoter.perTenant["a000-apps"]; len(got) != 1 || got[0] != 2 {
		t.Fatalf("the apps tenant must be promoted at the RESERVED gen2 on resume: %v", got)
	}
	// THE invariant D6 attacks: exactly ONE generation advance across the whole episode —
	// the partial abort + resume must not double-advance the ledger.
	if len(k8s.setGenTo) != 1 {
		t.Fatalf("the ledger advanced %d times across the episode, want exactly 1: %v", len(k8s.setGenTo), k8s.setGenTo)
	}
	if k8s.gen != 2 {
		t.Fatalf("final ledger = %d, want 2 (single advance, converged)", k8s.gen)
	}
	if k8s.selectorApp != "pageserver-standby" || len(k8s.flippedTo) != 1 {
		t.Fatalf("the plane must converge onto the standby with exactly one flip: sel=%q flips=%v", k8s.selectorApp, k8s.flippedTo)
	}
}
