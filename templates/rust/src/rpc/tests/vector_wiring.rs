//! The production constructor against the shared zone-identity token vectors.

use super::*;

/// The production constructor with a JWKS mounted and its issuer and
/// audience set: a zone token verifies on every protocol, against the auth
/// option the contract states for the RPC, and anything else is refused.
#[tokio::test]
async fn production_wiring_verifies_zone_tokens() {
    let v = crate::testvectors::load();
    let c = v.case("valid-user");
    assert_eq!(c.procedure, PUT_ITEM, "this test needs a PutItem token");
    let path = crate::testvectors::temp_dir("wiring").join("jwks.json");
    v.write_jwks(&path, &c.jwks);
    for wire in MATRIX {
        // One server per protocol: a token is single-use, and the same valid
        // token is the control on each of them.
        let running = start(new(Config {
            jwks_path: path.clone(),
            issuer: v.verifier.issuer.clone(),
            audience: v.verifier.audience.clone(),
            clock: crate::testvectors::TestClock::at(c.now).clock(),
            ..Config::default()
        }))
        .await;
        // Every refusal first: a refused token is not remembered, so the valid
        // token below is still unused, and a check that was dropped would
        // admit its case (and use up the valid token) rather than be masked.
        let client = example(&running, wire, Some(&v.token("valid-user")));
        // The valid token names PutItem, so it does not open GetItem.
        let err = client.get_item(get("a")).await.unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::Unauthenticated,
            "{} GetItem",
            wire.name
        );
        for name in ["user-empty-sub", "expired", "cross-zone", "wrong-audience"] {
            let client = example(&running, wire, Some(&v.token(name)));
            let err = client.put_item(put("a", "b")).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::Unauthenticated, "{} {name}", wire.name);
        }
        let err = example(&running, wire, None)
            .put_item(put("a", "b"))
            .await
            .unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::Unauthenticated,
            "{} no token",
            wire.name
        );
        client
            .put_item(put("a", "b"))
            .await
            .unwrap_or_else(|e| panic!("{}: PutItem with a valid zone token: {e:?}", wire.name));
        // A token is single-use: the same one again, with a body of the
        // attacker's choosing, is refused on every protocol.
        let err = example(&running, wire, Some(&v.token("valid-user")))
            .put_item(put("a", "attacker-chosen"))
            .await
            .unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::Unauthenticated,
            "{} PutItem with a token already used",
            wire.name
        );
        running.stop().await.unwrap();
    }
}

/// `Config::seen_capacity` reaches the token check: with room for one token,
/// the first valid token is served and a second, different valid token is
/// refused because the replay set is full (not because anything is wrong with
/// it).
#[tokio::test]
async fn seen_capacity_reaches_the_token_check() {
    let v = crate::testvectors::load();
    let c = v.case("valid-user");
    let path = crate::testvectors::temp_dir("wiring-capacity").join("jwks.json");
    v.write_jwks(&path, &c.jwks);
    let running = start(new(Config {
        jwks_path: path,
        issuer: v.verifier.issuer.clone(),
        audience: v.verifier.audience.clone(),
        clock: crate::testvectors::TestClock::at(c.now).clock(),
        seen_capacity: 1,
        ..Config::default()
    }))
    .await;
    let wire = MATRIX[0];
    example(&running, wire, Some(&v.token("valid-user")))
        .put_item(put("a", "b"))
        .await
        .expect("the first token");
    let err = example(&running, wire, Some(&v.token("valid-user-second-jti")))
        .put_item(put("a", "b"))
        .await
        .unwrap_err();
    assert_eq!(
        err.code,
        ErrorCode::Unauthenticated,
        "a second token with room for one"
    );
    running.stop().await.unwrap();
}
