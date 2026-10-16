//! The `(knext.v1.auth)` option of each RPC this function serves.
//!
//! connect-rust does not carry method options at run time, so the contract's
//! options are stated here, one line per RPC. `auth::vector_tests` parses the
//! proto source and holds this table to it, and `rpc::tests` holds every
//! registered procedure to having an entry: add an RPC to `proto/` and
//! register it without a line here, and a test reds. An RPC that is not in
//! the table is refused even with a valid token.

use crate::proto::knext::v1::Auth;

/// The `(knext.v1.auth)` option of `procedure`, or `AUTH_UNSPECIFIED` when
/// it states none or is not in a contract this function serves.
pub fn contract_auth(procedure: &str) -> Auth {
    match procedure {
        "/example.v1.ExampleService/GetItem" => Auth::AUTH_USER,
        "/example.v1.ExampleService/PutItem" => Auth::AUTH_USER,
        _ => Auth::AUTH_UNSPECIFIED,
    }
}
