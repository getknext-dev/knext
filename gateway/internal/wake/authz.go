package wake

// authz.go — apps-gateway tenant access control (issue #74).
//
// The apps-gateway (template mode) routes by the DSN database name and is a dumb
// byte pipe after the handshake: it does NOT speak SCRAM/md5 itself. So the
// tenant boundary is enforced in TWO layers:
//
//	Layer 1 (here, pre-wake): the gateway REFUSES a startup whose (user,database)
//	         pair is not a well-formed per-app pair — BEFORE waking anything. This
//	         blocks the two cheap cross-tenant attacks the review found:
//	           - database=<other-app> with the SAME user  -> user != app_<db>, refused
//	           - the shared cloud_admin credential          -> user != app_<db>, refused
//	           - database=tmpl|warm|ro (non-app computes)  -> reserved, refused
//	         Refusal is a clean 28P01 with NO wake and NO info leak (the message
//	         never reveals whether the target app exists).
//	Layer 2 (Postgres): each app compute boots a per-app role app_<app> with a
//	         per-app md5 password (provision-app.sh mints it into a Secret;
//	         compute_ctl applies the spec role every boot). So even a client that
//	         guesses the right user string still needs that app's password — which
//	         only that app's DATABASE_URL Secret holds.
//
// Only template mode implements Authorize; the primary single-DB pggw (kubectl
// mode) does not, so its path is completely untouched.

import (
	"fmt"
	"strings"
)

// AuthError is returned by Authorize on refusal. The gateway maps it to a clean
// FATAL 28P01. The message is UniformAuthFailure so it does not reveal whether
// the target database/app actually exists (no tenant-enumeration oracle).
type AuthError struct{ Msg string }

func (e *AuthError) Error() string { return e.Msg }

// AuthFailureCode is the SQLSTATE emitted for every uniform refusal on the
// apps-gateway (28P01, invalid_password) — the same code Postgres uses for a bad
// password, so a gateway-side refusal is indistinguishable from a backend one.
const AuthFailureCode = "28P01"

// UniformAuthFailure is the SINGLE client-facing refusal message the apps-gateway
// shows for ANY authentication/authorization failure on a syntactically-parseable
// startup: a wrong (user,database) pair, a reserved name, a malformed database, OR
// a syntactically-valid pair whose app does not exist (wake/resolve fails). It is
// byte-for-byte the message Postgres itself emits for a bad password (paired with
// AuthFailureCode 28P01), keyed ONLY on the user string the client supplied.
//
// Because the message never depends on cluster state, "app absent" and "wrong
// password" are indistinguishable to the client — this closes the tenant-existence
// oracle and the internal-object-name disclosure (issue #92). The real cause
// (k8s object names, scale errors) is logged server-side only, never on the wire.
func UniformAuthFailure(user string) string {
	return fmt.Sprintf("password authentication failed for user %q", user)
}

// rfc1123Label reports whether s is a valid RFC1123 DNS label: lowercase
// alphanumerics and '-', not starting/ending with '-', 1..63 chars. This is
// exactly the charset that yields a valid k8s object name (compute-<app>) and a
// safe DSN database token, so it doubles as injection defense on the {system}
// substitution.
func rfc1123Label(s string) bool {
	if len(s) == 0 || len(s) > 63 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'
		if !ok {
			return false
		}
	}
	if s[0] == '-' || s[len(s)-1] == '-' {
		return false
	}
	return true
}

// Authorize enforces the (user, database) tenant boundary for template mode.
// Returns nil when the pair is a well-formed per-app pair, else an *AuthError.
func (d *templateDriver) Authorize(user, database string) error {
	// Every refusal returns the IDENTICAL UniformAuthFailure message (keyed only
	// on the client-supplied user) so no branch leaks which class of failure it
	// was — malformed name, reserved name, wrong pair, or (later, in the gateway)
	// a valid pair for a non-existent app all look the same on the wire (#92).
	if !rfc1123Label(database) {
		// Malformed name: a pure client syntax error, independent of cluster
		// state. Still uniform so the front door never varies its message by
		// input class. The naming rule is documented in docs/connecting.md.
		return &AuthError{Msg: UniformAuthFailure(user)}
	}
	if d.reserved[database] {
		// Reserved (tmpl/warm/ro/...) route to non-app computes (the shared
		// template, warm/RO lanes). Uniform refusal — do not confirm they exist.
		return &AuthError{Msg: UniformAuthFailure(user)}
	}
	if want := d.rolePrefix + database; user != want {
		// cloud_admin -> any app, or app_A -> db B: the user must be the app's
		// own role. Uniform refusal (no oracle on which apps/roles exist).
		return &AuthError{Msg: UniformAuthFailure(user)}
	}
	return nil
}

// AuthorizeReplication enforces the tenant boundary for a REPLICATION (walreceiver)
// startup on the apps-gateway (ADR-0007 §4c option ii — gateway-mediated
// replication-wake). It is identical to Authorize EXCEPT the required role is the
// per-zone REPLICATION role (replRolePrefix+database, default repl_<zone>,
// ADR-0007 §4b) rather than the per-app app_<zone> role — because:
//
//   - app_<zone> has NO REPLICATION attribute, so it cannot drive a subscription;
//   - repl_<zone> HAS it, so it must never be usable for ordinary tenant traffic
//     (Authorize refuses it) — role separation keeps a replication credential from
//     becoming a general tenant credential.
//
// Malformed and reserved database names are refused identically, and every refusal
// returns the SAME UniformAuthFailure keyed only on the user, so the replication
// front door leaks no more than the ordinary one (issue #92). Returns nil when the
// pair is a well-formed per-zone replication pair, else an *AuthError.
func (d *templateDriver) AuthorizeReplication(user, database string) error {
	if !rfc1123Label(database) {
		return &AuthError{Msg: UniformAuthFailure(user)}
	}
	if d.reserved[database] {
		return &AuthError{Msg: UniformAuthFailure(user)}
	}
	if want := d.replRolePrefix + database; user != want {
		return &AuthError{Msg: UniformAuthFailure(user)}
	}
	return nil
}

// parseReserved turns "tmpl,warm,ro" into a set, trimming blanks.
func parseReserved(csv string) map[string]bool {
	out := map[string]bool{}
	for _, p := range strings.Split(csv, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out[p] = true
		}
	}
	return out
}
