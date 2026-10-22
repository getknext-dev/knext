//! The replay set on its own: expiry, the (iss, jti) key, the cap, and the
//! measured memory cost behind the default cap.

use std::sync::Arc;

use super::replay::{DEFAULT_SEEN_CAPACITY, SeenSet};
use super::{AuthError, CLOCK_SKEW_SECS};

const ISS: &str = "knext:zone:shop/storefront";

fn iss() -> Arc<str> {
    Arc::from(ISS)
}

/// Fixed ids, 22 characters like a real 128-bit jti.
fn jti(n: usize) -> String {
    format!("{n:022}")
}

/// An entry lives until exp + skew, and no longer: the token it stands for is
/// refused as expired from that second on, so forgetting it opens nothing.
#[test]
fn entry_lives_until_exp_plus_skew() {
    let set = SeenSet::new(10);
    let (iss, exp) = (iss(), 1000);
    set.admit(&iss, &jti(1), exp + CLOCK_SKEW_SECS, 900)
        .unwrap();
    for now in [901, exp, exp + CLOCK_SKEW_SECS - 1] {
        assert_eq!(
            set.admit(&iss, &jti(1), exp + CLOCK_SKEW_SECS, now),
            Err(AuthError::Replayed),
            "at {now}, before exp + skew = {}",
            exp + CLOCK_SKEW_SECS
        );
    }
    // At exp + skew the entry is purged by the next admission.
    set.admit(
        &iss,
        &jti(2),
        exp + CLOCK_SKEW_SECS + 60,
        exp + CLOCK_SKEW_SECS,
    )
    .unwrap();
    assert_eq!(set.len(), 1, "only the new token is left");
}

/// The key is (iss, jti): the same jti under two issuers is two tokens.
#[test]
fn key_includes_the_issuer() {
    let set = SeenSet::new(10);
    let (a, b): (Arc<str>, Arc<str>) = (
        Arc::from("knext:zone:shop/a"),
        Arc::from("knext:zone:shop/b"),
    );
    set.admit(&a, &jti(1), 2000, 1000).unwrap();
    set.admit(&b, &jti(1), 2000, 1000)
        .expect("the same jti from another issuer");
    assert_eq!(set.admit(&a, &jti(1), 2000, 1000), Err(AuthError::Replayed));
}

/// At the cap a new token is refused and NOT recorded, a seen token is still
/// reported as replayed, and nothing is evicted to make room.
#[test]
fn at_cap_refuses_new_and_forgets_none() {
    let set = SeenSet::new(3);
    let iss = iss();
    for i in 0..3 {
        set.admit(&iss, &jti(i), 2000, 1000).unwrap();
    }
    for _ in 0..2 {
        assert_eq!(
            set.admit(&iss, &jti(99), 2000, 1000),
            Err(AuthError::SeenSetFull)
        );
    }
    assert_eq!(
        set.len(),
        3,
        "a refused token was recorded or one was evicted"
    );
    for i in 0..3 {
        assert_eq!(
            set.admit(&iss, &jti(i), 2000, 1000),
            Err(AuthError::Replayed),
            "seen token {i} in a full set"
        );
    }
}

/// Expiry frees exactly the expired entries.
#[test]
fn purge_is_per_entry() {
    let set = SeenSet::new(2);
    let iss = iss();
    set.admit(&iss, &jti(1), 1055, 1000).unwrap();
    set.admit(&iss, &jti(2), 1100, 1040).unwrap();
    assert_eq!(
        set.admit(&iss, &jti(3), 1200, 1054),
        Err(AuthError::SeenSetFull),
        "before any entry expired"
    );
    set.admit(&iss, &jti(3), 1200, 1055)
        .expect("after the first entry expired");
    assert_eq!(
        set.admit(&iss, &jti(4), 1200, 1056),
        Err(AuthError::SeenSetFull),
        "only one place was freed"
    );
    assert_eq!(
        set.admit(&iss, &jti(2), 1100, 1056),
        Err(AuthError::Replayed),
        "the unexpired entry was forgotten"
    );
}

/// Entries that expire at the same second go together, and the bookkeeping
/// for an expired second is dropped with them: nothing accumulates.
#[test]
fn bookkeeping_is_released() {
    let set = SeenSet::new(100);
    let iss = iss();
    for i in 0..50 {
        set.admit(&iss, &jti(i), 1055 + i64::try_from(i % 5).unwrap(), 1000)
            .unwrap();
    }
    set.admit(&iss, &jti(1000), 5000, 2000).unwrap();
    assert_eq!((set.len(), set.expiry_buckets()), (1, 1));
}

#[test]
fn capacity_defaults() {
    assert_eq!(SeenSet::new(0).capacity(), DEFAULT_SEEN_CAPACITY);
    assert_eq!(SeenSet::new(7).capacity(), 7);
}

/// A panic while the set is being updated leaves it untrustworthy: from then
/// on every new token is refused (fail closed), not admitted unchecked.
#[test]
fn a_poisoned_set_refuses_every_token() {
    let set = SeenSet::new(10);
    let iss = iss();
    set.admit(&iss, &jti(1), 2000, 1000).unwrap();
    set.poison();
    assert_eq!(
        set.admit(&iss, &jti(2), 2000, 1000),
        Err(AuthError::SeenSetFull)
    );
    assert_eq!(
        set.admit(&iss, &jti(1), 2000, 1000),
        Err(AuthError::SeenSetFull)
    );
}
