package zone

import (
	"crypto/md5" //nolint:gosec // md5(password||role) is Neon compute_ctl's encrypted_password format, not a security hash
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// sql.go — PURE builders + validators for the SQL the operator emits, and the two
// governance guards ADR-0007 makes mandatory. Kept side-effect-free so the wire
// text, the identifier-injection defense, and the both-sides-agree /
// single-writer-per-replicated-table rules are all table-testable without a cluster.

// ---- identifier safety -----------------------------------------------------

// validTableIdent reports whether s is a safe (optionally schema-qualified)
// Postgres table identifier: each part starts with a letter/underscore and contains
// only [a-zA-Z0-9_], 1..63 chars. Table names arrive from user Zone specs, so this
// is injection defense on every CREATE PUBLICATION / IMPORT FOREIGN SCHEMA — a table
// that does not match is REFUSED (never quoted-and-hoped). No wildcards, no dots
// beyond one schema qualifier.
func validTableIdent(s string) bool {
	if s == "" {
		return false
	}
	parts := strings.Split(s, ".")
	if len(parts) > 2 {
		return false
	}
	for _, p := range parts {
		if !validSimpleIdent(p) {
			return false
		}
	}
	return true
}

func validSimpleIdent(p string) bool {
	if len(p) == 0 || len(p) > 63 {
		return false
	}
	for i := 0; i < len(p); i++ {
		c := p[i]
		isLetter := c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		isDigit := c >= '0' && c <= '9'
		if i == 0 && !isLetter {
			return false
		}
		if !isLetter && !isDigit {
			return false
		}
	}
	return true
}

// quoteIdent double-quotes a (already-validated) identifier, escaping embedded
// double quotes per SQL rules. Schema-qualified names are quoted part-wise.
func quoteIdent(s string) string {
	parts := strings.Split(s, ".")
	for i, p := range parts {
		parts[i] = `"` + strings.ReplaceAll(p, `"`, `""`) + `"`
	}
	return strings.Join(parts, ".")
}

// quoteLiteral single-quotes a string literal (for CONNECTION '...' etc.), escaping
// embedded single quotes. Used only for operator-built conninfo (host/port/db/user
// are all validated identifiers or the operator's own values), never raw user input.
func quoteLiteral(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// validateTables checks every table name in a list, returning the first offender.
func validateTables(tables []string) error {
	for _, t := range tables {
		if !validTableIdent(t) {
			return fmt.Errorf("invalid table name %q: must be a plain (optionally schema-qualified) identifier [a-zA-Z_][a-zA-Z0-9_]*", t)
		}
	}
	return nil
}

// ---- statement builders ----------------------------------------------------

// replRoleName is the per-zone REPLICATION role (ADR-0007 §4b), lock-step with the
// apps-gateway GW_REPL_ROLE_PREFIX (default repl_) it authorizes against (#140).
func replRoleName(prefix, zone string) string { return prefix + zone }

// subName is the subscription (and, on the peer, the auto-created slot) name for a
// dependency on fromZone. Deterministic so reconcile is idempotent and deprovision
// can name the exact peer slot to drop. Underscores (zone '-' → '_') keep it a legal
// unquoted-friendly identifier and a legal slot name (slots allow [a-z0-9_]).
func subName(fromZone string) string { return "zone_sub_" + slotSafe(fromZone) }

// slotSafe maps an RFC1123 zone label to the pg_replication_slots charset ([a-z0-9_]).
func slotSafe(zone string) string { return strings.ReplaceAll(zone, "-", "_") }

// fdwServer / fdwSchema name the postgres_fdw objects for a federated peer.
func fdwServer(fromZone string) string { return "zone_fdw_" + slotSafe(fromZone) }
func fdwSchema(fromZone string) string { return "zone_" + slotSafe(fromZone) }

// buildEnsureReplRole is an idempotent DO block that creates the per-zone repl role
// if absent, then (re)asserts LOGIN + REPLICATION + the md5 password every pass. The
// REPLICATION attribute is set explicitly here (the compute_ctl spec-role format
// carries only per-role GUCs, not attributes) — this is why the repl role is
// operator-SQL-managed rather than entrypoint-injected (ADR-0007 §4b, as-built).
// The role is durable on the timeline, so it survives scale-to-zero; the operator
// re-asserts it every reconcile as the "applied every boot" guarantee.
func buildEnsureReplRole(role, md5hex string) string {
	rq := quoteIdent(role)
	return fmt.Sprintf(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN
    CREATE ROLE %s WITH LOGIN REPLICATION PASSWORD 'md5%s';
  ELSE
    ALTER ROLE %s WITH LOGIN REPLICATION PASSWORD 'md5%s';
  END IF;
END $$;`, quoteLiteral(role), rq, md5hex, rq, md5hex)
}

// buildEnsurePublication ensures a publication for exactly the declared tables and
// GRANTs the repl role SELECT on them (a subscription's initial COPY + apply reads as
// the connecting role). Idempotent AND non-disruptive: it CREATEs the publication
// only when absent, then ALTER ... SET TABLE to reconcile the exact table set — it
// never DROPs a live publication (a drop+recreate each reconcile would tear down
// active subscriber streaming every pass). A removed table stops being exported via
// the ALTER SET.
func buildEnsurePublication(pub, replRole string, tables []string) (string, error) {
	if !validSimpleIdent(pub) {
		return "", fmt.Errorf("invalid publication name %q", pub)
	}
	if len(tables) == 0 {
		return "", fmt.Errorf("publication %q declares no tables", pub)
	}
	if err := validateTables(tables); err != nil {
		return "", err
	}
	quoted := make([]string, len(tables))
	for i, t := range tables {
		quoted[i] = quoteIdent(t)
	}
	tableList := strings.Join(quoted, ", ")
	var b strings.Builder
	fmt.Fprintf(&b, "GRANT USAGE ON SCHEMA public TO %s;\n", quoteIdent(replRole))
	fmt.Fprintf(&b, "GRANT SELECT ON TABLE %s TO %s;\n", tableList, quoteIdent(replRole))
	fmt.Fprintf(&b, `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = %s) THEN
    CREATE PUBLICATION %s FOR TABLE %s;
  END IF;
END $$;
`, quoteLiteral(pub), quoteIdent(pub), tableList)
	fmt.Fprintf(&b, "ALTER PUBLICATION %s SET TABLE %s;", quoteIdent(pub), tableList)
	return b.String(), nil
}

// buildDropPublication drops a publication (deprovision / removed export).
func buildDropPublication(pub string) string {
	return fmt.Sprintf("DROP PUBLICATION IF EXISTS %s;", quoteIdent(pub))
}

// conninfo builds the libpq CONNECTION string for a subscription/FDW pointing at the
// APPS-GATEWAY (so the merged #140 replication-wake wakes a sleeping publisher when
// the walreceiver connects). dbname is the PEER zone (the gateway routes database →
// compute-<peer>); user is repl_<peer>. sslmode=disable → the gateway declines SSL
// and pipes plaintext over the pod network (front-door TLS is a separate hardening).
func conninfo(gwHost string, gwPort int, peerZone, replRole, password string) string {
	return fmt.Sprintf("host=%s port=%d dbname=%s user=%s password=%s sslmode=disable",
		gwHost, gwPort, peerZone, replRole, password)
}

// buildEnsureSubscription creates a subscription to one-or-more peer publications
// over the gateway-mediated conninfo — exactly ONCE (create-if-absent). It is
// deliberately NOT drop+recreate: CREATE SUBSCRIPTION with copy_data re-runs the
// initial COPY, so recreating it every reconcile would re-copy the publication
// (PK-conflicting) and thrash the peer slot. The create is guarded by a psql \gset/
// \if existence check and runs OUTSIDE any transaction (CREATE SUBSCRIPTION cannot
// run inside a transaction/DO block). copy_data=true backfills on first create;
// create_slot=true auto-creates the slot named after the subscription — the exact
// name deprovision drops on the peer (ADR-0007 §4d).
func buildEnsureSubscription(sub, conn string, publications []string) (string, error) {
	if !validSimpleIdent(sub) {
		return "", fmt.Errorf("invalid subscription name %q", sub)
	}
	if len(publications) == 0 {
		return "", fmt.Errorf("subscription %q references no publications", sub)
	}
	for _, p := range publications {
		if !validSimpleIdent(p) {
			return "", fmt.Errorf("invalid publication name %q", p)
		}
	}
	pubList := strings.Join(publications, ", ")
	return fmt.Sprintf(`SELECT NOT EXISTS (SELECT 1 FROM pg_subscription WHERE subname = %s) AS zone_need_sub
\gset
\if :zone_need_sub
CREATE SUBSCRIPTION %s CONNECTION %s PUBLICATION %s WITH (copy_data = true, create_slot = true);
\endif`, quoteLiteral(sub), quoteIdent(sub), quoteLiteral(conn), pubList), nil
}

// buildDropSubscription disables + detaches the slot BEFORE dropping so the local
// drop never blocks on an unreachable publisher (ADR-0007 §4d — drop the subscriber
// side first). The peer slot is then dropped explicitly by the operator
// (buildDropReplicationSlot) after waking the peer. Idempotent: the ALTERs (which
// have no IF EXISTS form) run only inside an existence guard, so a second
// deprovision pass over an already-dropped subscription is a clean no-op.
func buildDropSubscription(sub string) string {
	q := quoteIdent(sub)
	return fmt.Sprintf(`DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_subscription WHERE subname = %s) THEN
    ALTER SUBSCRIPTION %s DISABLE;
    ALTER SUBSCRIPTION %s SET (slot_name = NONE);
  END IF;
END $$;
DROP SUBSCRIPTION IF EXISTS %s;`, quoteLiteral(sub), q, q, q)
}

// buildDropReplicationSlot drops an inactive logical slot on a peer publisher
// (ADR-0007 §4d — after the subscriber side is gone, so it cannot be re-pinned).
// Guarded on inactivity: a still-active slot is skipped (never forcibly killed).
func buildDropReplicationSlot(slot string) string {
	return fmt.Sprintf(
		"SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = %s AND NOT active;",
		quoteLiteral(slot))
}

// buildEnsureFederation provisions postgres_fdw for a peer dependency (mode:
// federate, ADR-0007 §2b): the extension, a foreign server pointing at the gateway,
// a user mapping (repl role + password), a dedicated schema, and IMPORT FOREIGN
// SCHEMA LIMIT TO exactly the declared tables. Idempotent: DROP SERVER ... CASCADE
// then recreate keeps the foreign-table set in lock-step with the spec.
func buildEnsureFederation(fromZone, gwHost string, gwPort int, replRole, password string, tables []string) (string, error) {
	if err := validateTables(tables); err != nil {
		return "", err
	}
	if len(tables) == 0 {
		return "", fmt.Errorf("federation on %q declares no tables", fromZone)
	}
	srv := fdwServer(fromZone)
	sch := fdwSchema(fromZone)
	quoted := make([]string, len(tables))
	for i, t := range tables {
		// IMPORT FOREIGN SCHEMA LIMIT TO uses bare (schema-stripped) table names.
		name := t
		if i := strings.LastIndex(t, "."); i >= 0 {
			name = t[i+1:]
		}
		quoted[i] = quoteIdent(name)
	}
	var b strings.Builder
	b.WriteString("CREATE EXTENSION IF NOT EXISTS postgres_fdw;\n")
	fmt.Fprintf(&b, "DROP SERVER IF EXISTS %s CASCADE;\n", quoteIdent(srv))
	fmt.Fprintf(&b, "CREATE SERVER %s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host %s, port %s, dbname %s);\n",
		quoteIdent(srv), quoteLiteral(gwHost), quoteLiteral(fmt.Sprintf("%d", gwPort)), quoteLiteral(fromZone))
	fmt.Fprintf(&b, "CREATE USER MAPPING FOR CURRENT_USER SERVER %s OPTIONS (user %s, password %s);\n",
		quoteIdent(srv), quoteLiteral(replRole), quoteLiteral(password))
	fmt.Fprintf(&b, "DROP SCHEMA IF EXISTS %s CASCADE;\n", quoteIdent(sch))
	fmt.Fprintf(&b, "CREATE SCHEMA %s;\n", quoteIdent(sch))
	fmt.Fprintf(&b, "IMPORT FOREIGN SCHEMA public LIMIT TO (%s) FROM SERVER %s INTO %s;",
		strings.Join(quoted, ", "), quoteIdent(srv), quoteIdent(sch))
	return b.String(), nil
}

// buildDropFederation removes a federated peer's FDW objects (deprovision).
func buildDropFederation(fromZone string) string {
	return fmt.Sprintf("DROP SERVER IF EXISTS %s CASCADE;\nDROP SCHEMA IF EXISTS %s CASCADE;",
		quoteIdent(fdwServer(fromZone)), quoteIdent(fdwSchema(fromZone)))
}

// zoneMD5 is compute_ctl's encrypted_password format WITHOUT the "md5" prefix (the
// callers add "md5" where Postgres wants it): raw md5(password||rolename). Matches
// provision-app.sh app_md5 and the appdb operator.
func zoneMD5(password, role string) string {
	sum := md5.Sum([]byte(password + role)) //nolint:gosec // format required by Neon compute_ctl
	return hex.EncodeToString(sum[:])
}

// ---- governance guards (ADR-0007 §3 + §5) ----------------------------------

// publisherIndex maps table → the set of zones that publish it, across ALL zones'
// spec.publishes. It is the substrate for both governance guards.
func publisherIndex(zones []*Zone) map[string]map[string]bool {
	idx := map[string]map[string]bool{}
	for _, z := range zones {
		for _, p := range z.Spec.Publishes {
			for _, t := range p.Tables {
				if idx[t] == nil {
					idx[t] = map[string]bool{}
				}
				idx[t][z.Name] = true
			}
		}
	}
	return idx
}

// publishedByZone returns the set of tables a specific zone exports (union of its
// publications) — the peer's "published set" the both-sides-agree gate checks against.
func publishedByZone(z *Zone) map[string]bool {
	out := map[string]bool{}
	if z == nil {
		return out
	}
	for _, p := range z.Spec.Publishes {
		for _, t := range p.Tables {
			out[t] = true
		}
	}
	return out
}

// pubsCovering returns the peer publication NAMES whose table sets intersect the
// requested tables — the publications a subscription must reference to import them.
// Sorted for deterministic SQL.
func pubsCovering(peer *Zone, requested []string) []string {
	want := map[string]bool{}
	for _, t := range requested {
		want[t] = true
	}
	set := map[string]bool{}
	for _, p := range peer.Spec.Publishes {
		for _, t := range p.Tables {
			if want[t] {
				set[p.Name] = true
				break
			}
		}
	}
	out := make([]string, 0, len(set))
	for n := range set {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// checkBothSidesAgree enforces ADR-0007 §3: a dependency is wired only when the peer
// PUBLISHES every requested table. Returns the tables the peer does NOT publish (the
// governance denial set) — empty means the dependency is granted. A peer that does
// not exist yields all requested tables as ungranted (caller reports "unknown peer").
func checkBothSidesAgree(peer *Zone, requested []string) []string {
	published := publishedByZone(peer)
	var ungranted []string
	for _, t := range requested {
		if !published[t] {
			ungranted = append(ungranted, t)
		}
	}
	return ungranted
}

// checkSingleWriter enforces ADR-0007 §5's single-writer-per-replicated-table rule at
// the spec level, from THIS zone's point of view. Two violations are fatal:
//
//   - a table is published by MORE THAN ONE zone (bidirectional / multi-writer
//     replication of the same logical row — no conflict resolution on this
//     foundation, so "eventual" would become "eventually wrong"); and
//   - this zone IMPORTS (replicate) a table it ALSO publishes — importing a copy of a
//     table you write locally means the replicated copy and the local writes both
//     claim the row.
//
// Returns a human-readable violation, or "" when clean. self is the zone being
// reconciled; zones is every zone in the namespace.
func checkSingleWriter(self *Zone, zones []*Zone) string {
	idx := publisherIndex(zones)

	multiPub := func(t string) []string {
		pubs := idx[t]
		if len(pubs) <= 1 {
			return nil
		}
		names := make([]string, 0, len(pubs))
		for n := range pubs {
			names = append(names, n)
		}
		sort.Strings(names)
		return names
	}

	// (1) a table published by more than one zone — flagged when SELF is one of the
	//     publishers (self's own reconcile owns the violation).
	for t := range idx {
		if names := multiPub(t); names != nil && idx[t][self.Name] {
			return fmt.Sprintf("single-writer violation: table %q is published by %d zones (%s) — a replicated table may be published by at most one zone (ADR-0007 §5)",
				t, len(names), strings.Join(names, ", "))
		}
	}

	// (2) this zone imports (replicate) a table it also publishes.
	selfPub := publishedByZone(self)
	for _, d := range self.Spec.DataDependencies {
		if d.Mode != ModeReplicate {
			continue
		}
		for _, t := range d.Tables {
			if selfPub[t] {
				return fmt.Sprintf("single-writer violation: zone %q both publishes and replicate-imports table %q — a table replicated INTO a zone must not also be written locally (ADR-0007 §4f/§5)",
					self.Name, t)
			}
			// (3) SELF replicate-imports a table published by MORE THAN ONE peer — an
			//     ambiguous multi-writer source (X imports T while A+B both publish T).
			//     Even though X is not itself a publisher, it cannot pick a single
			//     authoritative writer, so the dependency is unsafe (§5).
			if names := multiPub(t); names != nil {
				return fmt.Sprintf("single-writer violation: zone %q replicate-imports table %q which is published by %d zones (%s) — a replicated table must have exactly one publisher (ADR-0007 §5)",
					self.Name, t, len(names), strings.Join(names, ", "))
			}
		}
	}
	return ""
}
