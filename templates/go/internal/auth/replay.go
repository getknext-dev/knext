package auth

import (
	"sync"
	"time"
)

// A token is single-use. The verifier keeps every token it has accepted, by
// (iss, jti), until the token could no longer be accepted anyway (exp plus the
// clock skew), and refuses a second use. That closes replay of a token captured
// on the pod network, to this pod, for the rest of the token's life.
//
// What it does not close, and the docs and the threat model say so:
//   - The set is in this pod's memory. A token can still be replayed once to a
//     different replica, and again after this pod restarts or scales to zero.
//   - The token does not cover the request body, so the first use of a captured
//     token (one that wins the race with the original) carries any body.
//
// The set is bounded. At the cap it refuses NEW tokens and never evicts one it
// has seen, because evicting is exactly how a replay gets through: a full set
// fails closed, as the rest of the check does.
const (
	// DefaultSeenCapacity is how many tokens the set holds. A token is held at
	// most 65 s (60 s of life plus 5 s of skew), so a pod holds about 65 times
	// its rate of verified calls: 65,536 is the set of a pod doing about 1,000
	// verified calls a second. Its cost is measured by
	// TestSeenSetMemoryCostAtTheDefaultCap. A pod busier than that refuses
	// calls, which is the signal to scale out or to raise Config.SeenCapacity.
	DefaultSeenCapacity = 65536
	// MinJTIChars and MaxJTIChars bound a jti: 22 base64url characters are the
	// 16 random bytes (128 bits) the signer mints; the maximum keeps an entry small.
	MinJTIChars = 22
	MaxJTIChars = 64
)

// seenKey is what a token is remembered by.
type seenKey struct{ iss, jti string }

type seenSet struct {
	mu       sync.Mutex
	capacity int
	entries  map[seenKey]int64   // key -> the second the entry may be forgotten
	byExpiry map[int64][]seenKey // forget-second -> its keys, so a purge is O(expired)
	nextGone int64               // the earliest forget-second in byExpiry (valid when it is non-empty)
}

func newSeenSet(capacity int) *seenSet {
	if capacity <= 0 {
		capacity = DefaultSeenCapacity
	}
	return &seenSet{
		capacity: capacity,
		entries:  make(map[seenKey]int64),
		byExpiry: make(map[int64][]seenKey),
	}
}

// admit records a token that passed every other check, or refuses it: with
// ErrReplayed if it has been seen, ErrSeenSetFull if it is new and the set is
// full. forgetAt is the Unix second from which the entry may be forgotten
// (exp + skew); now is the verifier's clock, in Unix seconds.
func (s *seenSet) admit(iss, jti string, forgetAt, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purge(now)
	k := seenKey{iss, jti}
	if _, seen := s.entries[k]; seen {
		return ErrReplayed
	}
	if len(s.entries) >= s.capacity {
		return ErrSeenSetFull
	}
	s.entries[k] = forgetAt
	if len(s.byExpiry) == 0 || forgetAt < s.nextGone {
		s.nextGone = forgetAt
	}
	s.byExpiry[forgetAt] = append(s.byExpiry[forgetAt], k)
	return nil
}

// purge forgets the entries whose second has come. Caller holds mu.
func (s *seenSet) purge(now int64) {
	if len(s.byExpiry) == 0 || s.nextGone > now {
		return
	}
	var next int64
	remaining := false
	for at, keys := range s.byExpiry {
		if at <= now {
			for _, k := range keys {
				delete(s.entries, k)
			}
			delete(s.byExpiry, at)
			continue
		}
		if !remaining || at < next {
			next, remaining = at, true
		}
	}
	s.nextGone = next
}

func (s *seenSet) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// seenSkew is the clock skew in seconds: an entry outlives its token's exp by it.
const seenSkew = int64(ClockSkew / time.Second)

// validJTI reports whether a jti is MinJTIChars..MaxJTIChars of the base64url alphabet.
func validJTI(jti string) bool {
	if len(jti) < MinJTIChars || len(jti) > MaxJTIChars {
		return false
	}
	for i := 0; i < len(jti); i++ {
		c := jti[i]
		if !('A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
