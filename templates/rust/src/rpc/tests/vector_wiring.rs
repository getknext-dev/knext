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
    let running = start(new(Config {
        jwks_path: path,
        issuer: v.verifier.issuer.clone(),
        audience: v.verifier.audience.clone(),
        clock: crate::testvectors::TestClock::at(c.now).clock(),
        ..Config::default()
    }))
    .await;
    for wire in MATRIX {
        let client = example(&running, wire, Some(&v.token("valid-user")));
        client
            .put_item(put("a", "b"))
            .await
            .unwrap_or_else(|e| panic!("{}: PutItem with a valid zone token: {e:?}", wire.name));
        // The same token names PutItem, so it does not open GetItem.
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
    }
    running.stop().await.unwrap();
}
