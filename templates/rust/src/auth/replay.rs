//! A token is single-use. The verifier keeps every token it has accepted, by
//! `(iss, jti)`, until the token could no longer be accepted anyway (`exp`
//! plus the clock skew), and refuses a second use. That closes replay of a
//! token captured on the pod network, to this pod, for the rest of the
//! token's life.
//!
//! What it does not close, and the docs and the threat model say so:
//!
//! - The set is in this pod's memory. A token can still be replayed once to a
//!   different replica, and again after this pod restarts or scales to zero.
//! - The token does not cover the request body, so the first use of a captured
//!   token (one that wins the race with the original) carries any body.
//!
//! The set is bounded. At the cap it refuses NEW tokens and never evicts one it
//! has seen, because evicting is exactly how a replay gets through: a full set
//! fails closed, as the rest of the check does.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use super::AuthError;

/// How many tokens the set holds. A token is held at most 65 s (60 s of life
/// plus 5 s of skew), so a pod holds about 65 times its rate of verified
/// calls: 65,536 is the set of a pod doing about 1,000 verified calls a
/// second. Its cost is measured by `memory_cost_at_the_default_cap` (about
/// 154 bytes an entry in Rust). A pod busier than that refuses new tokens with
/// `resource_exhausted`. Those refusals are fast, so they do not raise the
/// concurrency Knative scales on: the autoscaler gets no signal from them.
/// Raise `TokenConfig::seen_capacity`, or spread the calls over more pods
/// yourself.
pub const DEFAULT_SEEN_CAPACITY: usize = 65_536;
/// A `jti` is `MIN_JTI_CHARS..=MAX_JTI_CHARS` base64url characters: 22 are the
/// 16 random bytes (128 bits) the signer mints, and the maximum keeps an entry
/// small.
pub const MIN_JTI_CHARS: usize = 22;
pub const MAX_JTI_CHARS: usize = 64;

/// What a token is remembered by. The issuer is the verifier's configured
/// string, shared by every entry.
#[derive(Clone, PartialEq, Eq, Hash)]
struct SeenKey {
    iss: Arc<str>,
    jti: Arc<str>,
}

struct Inner {
    capacity: usize,
    /// key -> the second the entry may be forgotten.
    entries: HashMap<SeenKey, i64>,
    /// forget-second -> its keys, so a purge costs what it frees.
    by_expiry: BTreeMap<i64, Vec<SeenKey>>,
}

pub(super) struct SeenSet(Mutex<Inner>);

impl SeenSet {
    /// A set of `capacity` tokens; zero is [`DEFAULT_SEEN_CAPACITY`].
    pub(super) fn new(capacity: usize) -> Self {
        let capacity = if capacity == 0 {
            DEFAULT_SEEN_CAPACITY
        } else {
            capacity
        };
        Self(Mutex::new(Inner {
            capacity,
            entries: HashMap::new(),
            by_expiry: BTreeMap::new(),
        }))
    }

    /// Records a token that passed every other check, or refuses it: with
    /// [`AuthError::Replayed`] if it has been seen, [`AuthError::SeenSetFull`]
    /// if it is new and the set is full. `forget_at` is the Unix second from
    /// which the entry may be forgotten (`exp` + skew); `now` is the
    /// verifier's clock, in Unix seconds.
    pub(super) fn admit(
        &self,
        iss: &Arc<str>,
        jti: &str,
        forget_at: i64,
        now: i64,
    ) -> Result<(), AuthError> {
        // A poisoned lock means a panic mid-update: the set can no longer be
        // trusted, so every new token is refused (fail closed).
        let mut set = self
            .0
            .lock()
            .map_err(|_: PoisonError<_>| AuthError::SeenSetFull)?;
        set.purge(now);
        let key = SeenKey {
            iss: Arc::clone(iss),
            jti: Arc::from(jti),
        };
        if set.entries.contains_key(&key) {
            return Err(AuthError::Replayed);
        }
        if set.entries.len() >= set.capacity {
            return Err(AuthError::SeenSetFull);
        }
        set.entries.insert(key.clone(), forget_at);
        set.by_expiry.entry(forget_at).or_default().push(key);
        Ok(())
    }

    /// Poisons the lock, as a panic mid-update would.
    #[cfg(test)]
    pub(super) fn poison(&self) {
        std::thread::scope(|scope| {
            let _ = scope
                .spawn(|| {
                    let _held = self.0.lock().unwrap();
                    panic!("poisoning the replay set on purpose");
                })
                .join();
        });
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.0.lock().unwrap().entries.len()
    }

    #[cfg(test)]
    pub(super) fn expiry_buckets(&self) -> usize {
        self.0.lock().unwrap().by_expiry.len()
    }

    /// The capacity in effect (the default when none was configured).
    pub(super) fn capacity(&self) -> usize {
        self.0.lock().unwrap().capacity
    }
}

impl Inner {
    /// Forgets the entries whose second has come.
    fn purge(&mut self, now: i64) {
        while let Some(due) = self.by_expiry.first_entry() {
            if *due.key() > now {
                break;
            }
            for key in due.remove() {
                self.entries.remove(&key);
            }
        }
    }
}

/// Whether `jti` is `MIN_JTI_CHARS..=MAX_JTI_CHARS` of the base64url alphabet.
pub(super) fn valid_jti(jti: &str) -> bool {
    (MIN_JTI_CHARS..=MAX_JTI_CHARS).contains(&jti.len())
        && jti
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
