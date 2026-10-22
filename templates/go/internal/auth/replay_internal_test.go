package auth

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"testing"
)

// Fixed ids, 22 base64url characters like a real 128-bit jti.
func jti(n int) string { return fmt.Sprintf("%022d", n) }

const (
	iss  = "knext:zone:shop/storefront"
	skew = int64(ClockSkew / 1e9)
)

// An entry lives until exp + skew, and no longer: the token it stands for is
// refused as expired from that second on, so forgetting it opens nothing.
func TestSeenSetEntryLivesUntilExpPlusSkew(t *testing.T) {
	s := newSeenSet(10)
	const exp = int64(1000)
	if err := s.admit(iss, jti(1), exp+skew, 900); err != nil {
		t.Fatal(err)
	}
	for _, now := range []int64{901, exp, exp + skew - 1} {
		if err := s.admit(iss, jti(1), exp+skew, now); !errors.Is(err, ErrReplayed) {
			t.Fatalf("at %d (before exp+skew = %d): err = %v; want ErrReplayed", now, exp+skew, err)
		}
	}
	// At exp + skew the entry is purged by the next admission.
	if err := s.admit(iss, jti(2), exp+skew+60, exp+skew); err != nil {
		t.Fatal(err)
	}
	if got := s.len(); got != 1 {
		t.Fatalf("len = %d after the entry expired; want 1 (only the new token)", got)
	}
}

// The key is (iss, jti): the same jti under two issuers is two tokens.
func TestSeenSetKeyIncludesTheIssuer(t *testing.T) {
	s := newSeenSet(10)
	if err := s.admit("knext:zone:shop/a", jti(1), 2000, 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.admit("knext:zone:shop/b", jti(1), 2000, 1000); err != nil {
		t.Fatalf("the same jti from another issuer was refused: %v", err)
	}
	if err := s.admit("knext:zone:shop/a", jti(1), 2000, 1000); !errors.Is(err, ErrReplayed) {
		t.Fatalf("the same (iss, jti) again: err = %v; want ErrReplayed", err)
	}
}

// At the cap a new token is refused and NOT recorded, a seen token is still
// reported as replayed, and nothing is evicted to make room.
func TestSeenSetAtCapRefusesNewAndForgetsNone(t *testing.T) {
	s := newSeenSet(3)
	for i := range 3 {
		if err := s.admit(iss, jti(i), 2000, 1000); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := s.admit(iss, jti(99), 2000, 1000); !errors.Is(err, ErrSeenSetFull) {
			t.Fatalf("a new token into a full set: err = %v; want ErrSeenSetFull", err)
		}
	}
	if got := s.len(); got != 3 {
		t.Fatalf("len = %d; a refused token was recorded or an entry was evicted (want 3)", got)
	}
	for i := range 3 {
		if err := s.admit(iss, jti(i), 2000, 1000); !errors.Is(err, ErrReplayed) {
			t.Fatalf("seen token %d in a full set: err = %v; want ErrReplayed", i, err)
		}
	}
}

// Expiry frees exactly the expired entries.
func TestSeenSetPurgesPerEntry(t *testing.T) {
	s := newSeenSet(2)
	if err := s.admit(iss, jti(1), 1055, 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.admit(iss, jti(2), 1100, 1040); err != nil {
		t.Fatal(err)
	}
	if err := s.admit(iss, jti(3), 1200, 1054); !errors.Is(err, ErrSeenSetFull) {
		t.Fatalf("before any entry expired: err = %v; want ErrSeenSetFull", err)
	}
	if err := s.admit(iss, jti(3), 1200, 1055); err != nil {
		t.Fatalf("after the first entry expired: %v", err)
	}
	if err := s.admit(iss, jti(4), 1200, 1056); !errors.Is(err, ErrSeenSetFull) {
		t.Fatalf("only one place was freed: err = %v; want ErrSeenSetFull", err)
	}
	if err := s.admit(iss, jti(2), 1100, 1056); !errors.Is(err, ErrReplayed) {
		t.Fatalf("the unexpired entry was forgotten: err = %v; want ErrReplayed", err)
	}
}

// Entries that expire at the same second go together, and the bookkeeping for
// an expired second is dropped with them (nothing accumulates).
func TestSeenSetBookkeepingIsReleased(t *testing.T) {
	s := newSeenSet(100)
	for i := range 50 {
		if err := s.admit(iss, jti(i), 1055+int64(i%5), 1000); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.admit(iss, jti(1000), 5000, 2000); err != nil {
		t.Fatal(err)
	}
	if s.len() != 1 || len(s.byExpiry) != 1 {
		t.Fatalf("after everything expired: %d entries, %d expiry buckets; want 1 and 1", s.len(), len(s.byExpiry))
	}
}

func TestSeenSetCapacityDefaults(t *testing.T) {
	for _, c := range []int{0, -1} {
		if got := newSeenSet(c).capacity; got != DefaultSeenCapacity {
			t.Errorf("capacity %d -> %d; want the default %d", c, got, DefaultSeenCapacity)
		}
	}
	if got := newSeenSet(7).capacity; got != 7 {
		t.Errorf("capacity 7 -> %d", got)
	}
}

// The measured cost behind DefaultSeenCapacity. Tokens live at most 65 s in the
// set, so a pod holds rate x 65 entries: the default cap is that for ~1,000
// verified calls a second per pod. This test fills the set to the cap with real
// ids and issuer, measures the retained heap, and holds the per-entry cost and
// the total under a stated bound, so a change that doubles the cost reds here.
func TestSeenSetMemoryCostAtTheDefaultCap(t *testing.T) {
	const perEntryBudget = 200 // bytes; measured 152 in Go on go1.26 arm64 (Rust measures 154)
	s := newSeenSet(DefaultSeenCapacity)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for i := range DefaultSeenCapacity {
		// A fresh string per entry, as the verifier gets from a parsed token.
		id := fmt.Sprintf("%022d", i)
		// The issuer is the verifier's configured string, shared by every entry.
		if err := s.admit(iss, id, 2000+int64(i%65), 1000); err != nil {
			t.Fatalf("entry %d: %v", i, err)
		}
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	if s.len() != DefaultSeenCapacity {
		t.Fatalf("len = %d; want the cap %d", s.len(), DefaultSeenCapacity)
	}
	used := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	perEntry := used / int64(DefaultSeenCapacity)
	t.Logf("MEASURED: %d entries retain %d bytes = %d bytes/entry (%.1f MiB at the cap)",
		DefaultSeenCapacity, used, perEntry, float64(used)/(1<<20))
	if perEntry > perEntryBudget {
		t.Fatalf("%d bytes per entry; budget %d", perEntry, perEntryBudget)
	}
	runtime.KeepAlive(s)
}

// Many goroutines admitting distinct tokens, and the same ones, at once: no
// lost update, no data race (run under -race), and exactly one admission of
// each token. A set that is not locked fails this, whether the race detector
// or a lost entry shows it first.
func TestSeenSetIsSafeUnderConcurrency(t *testing.T) {
	const workers, perWorker = 16, 2000
	s := newSeenSet(workers * perWorker)
	var admitted [workers * perWorker]int32
	var mu sync.Mutex
	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Every worker offers every token, in its own order: each is admitted once overall.
			for i := range workers * perWorker {
				n := (i + w*perWorker) % (workers * perWorker)
				if s.admit(iss, jti(n), 5000+int64(n%7), 1000) == nil {
					mu.Lock()
					admitted[n]++
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	for n, got := range admitted {
		if got != 1 {
			t.Fatalf("token %d was admitted %d times; want exactly 1", n, got)
		}
	}
	if got := s.len(); got != workers*perWorker {
		t.Fatalf("len = %d; want %d", got, workers*perWorker)
	}
}
