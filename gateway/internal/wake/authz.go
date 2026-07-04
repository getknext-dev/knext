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
// FATAL 28P01 (invalid_authorization_specification). The message is deliberately
// uniform for the authorization cases so it does not reveal whether the target
// database/app actually exists (no tenant-enumeration oracle).
type AuthError struct{ Msg string }

func (e *AuthError) Error() string { return e.Msg }

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
	if !rfc1123Label(database) {
		// A malformed database name is a client error, not a tenancy oracle:
		// naming the rule is safe and helps legitimate misconfig.
		return &AuthError{Msg: fmt.Sprintf("invalid database name %q: must be a lowercase RFC1123 label ([a-z0-9-], not edge '-')", database)}
	}
	if d.reserved[database] {
		// Reserved (tmpl/warm/ro/...) route to non-app computes (the shared
		// template, warm/RO lanes). Uniform refusal — do not confirm they exist.
		return &AuthError{Msg: fmt.Sprintf("authentication failed for database %q", database)}
	}
	if want := d.rolePrefix + database; user != want {
		// cloud_admin -> any app, or app_A -> db B: the user must be the app's
		// own role. Uniform refusal (no oracle on which apps/roles exist).
		return &AuthError{Msg: fmt.Sprintf("authentication failed for user %q on database %q", user, database)}
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
