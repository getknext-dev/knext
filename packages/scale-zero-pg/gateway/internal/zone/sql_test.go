package zone

import (
	"strings"
	"testing"
)

func TestValidTableIdent(t *testing.T) {
	ok := []string{"orders", "order_lines", "public.customers", "_x", "T1", "s.t_2"}
	bad := []string{"", "1abc", "a.b.c", "orders; DROP TABLE x", "a b", "tbl-1", "'x'", "a.", ".b", strings.Repeat("x", 64)}
	for _, s := range ok {
		if !validTableIdent(s) {
			t.Errorf("validTableIdent(%q)=false, want true", s)
		}
	}
	for _, s := range bad {
		if validTableIdent(s) {
			t.Errorf("validTableIdent(%q)=true, want false (injection defense)", s)
		}
	}
}

func TestBuildEnsurePublicationRejectsInjection(t *testing.T) {
	if _, err := buildEnsurePublication("orders_pub", "repl_za", []string{"orders", "evil; DROP TABLE users"}); err == nil {
		t.Fatal("expected buildEnsurePublication to REFUSE an injection table name")
	}
	sql, err := buildEnsurePublication("orders_pub", "repl_za", []string{"orders", "public.order_lines"})
	if err != nil {
		t.Fatalf("valid publication: %v", err)
	}
	for _, want := range []string{
		`CREATE PUBLICATION "orders_pub" FOR TABLE "orders", "public"."order_lines"`,
		`GRANT SELECT ON TABLE "orders", "public"."order_lines" TO "repl_za"`,
		`ALTER PUBLICATION "orders_pub" SET TABLE "orders", "public"."order_lines"`,
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("publication SQL missing %q\n got: %s", want, sql)
		}
	}
	// Non-disruptive: must NOT drop a live publication on every reconcile.
	if strings.Contains(sql, "DROP PUBLICATION") {
		t.Errorf("ensure-publication must not DROP (tears down live streaming): %s", sql)
	}
}

func TestBuildEnsureSubscriptionUsesGatewayConninfo(t *testing.T) {
	conn := conninfo("pggw-apps.scale-zero-pg.svc", 55432, "za", "repl_za", "s3cr3t")
	for _, want := range []string{"host=pggw-apps.scale-zero-pg.svc", "port=55432", "dbname=za", "user=repl_za", "sslmode=disable"} {
		if !strings.Contains(conn, want) {
			t.Errorf("conninfo missing %q: %s", want, conn)
		}
	}
	sql, err := buildEnsureSubscription("zone_sub_za", conn, []string{"orders_pub"})
	if err != nil {
		t.Fatalf("subscription: %v", err)
	}
	if !strings.Contains(sql, `CREATE SUBSCRIPTION "zone_sub_za" CONNECTION 'host=pggw-apps`) {
		t.Errorf("subscription SQL wrong: %s", sql)
	}
	if !strings.Contains(sql, "create_slot = true") || !strings.Contains(sql, "copy_data = true") {
		t.Errorf("subscription must copy_data + create_slot: %s", sql)
	}
	// Create-once, guarded — must NOT drop+recreate every reconcile (re-copy/PK
	// conflict + slot thrash).
	if strings.Contains(sql, "DROP SUBSCRIPTION") {
		t.Errorf("ensure-subscription must not DROP+recreate: %s", sql)
	}
	if !strings.Contains(sql, `\if :zone_need_sub`) {
		t.Errorf("ensure-subscription must guard the create on non-existence: %s", sql)
	}
}

func TestBuildResyncSubscriptionDropsThenRecreatesWithCopy(t *testing.T) {
	conn := conninfo("pggw-apps.scale-zero-pg.svc", 55432, "za", "repl_za", "s3cr3t")
	sql, err := buildResyncSubscription("zone_sub_za", conn, []string{"orders_pub"})
	if err != nil {
		t.Fatalf("resync: %v", err)
	}
	// Re-sync MUST DISABLE, then DROP (dropping the remote lost slot with it) THEN
	// recreate with copy_data + a fresh slot — unlike ensure-subscription, unconditional.
	iDisable := strings.Index(sql, "DISABLE")
	iDrop := strings.Index(sql, "DROP SUBSCRIPTION")
	iCreate := strings.Index(sql, "CREATE SUBSCRIPTION")
	if !(iDisable >= 0 && iDrop > iDisable && iCreate > iDrop) {
		t.Errorf("resync must DISABLE -> DROP -> CREATE: %s", sql)
	}
	if !strings.Contains(sql, "copy_data = true") || !strings.Contains(sql, "create_slot = true") {
		t.Errorf("resync must copy_data + create a fresh slot: %s", sql)
	}
	// MUST NOT detach the slot: slot_name = NONE would orphan the lost slot under its
	// deterministic name and make create_slot collide. The DROP must free the name.
	if strings.Contains(sql, "slot_name = NONE") {
		t.Errorf("resync must NOT detach (slot_name = NONE) — it must drop the remote slot to free the name: %s", sql)
	}
	if strings.Contains(sql, `\if`) {
		t.Errorf("resync create must be UNCONDITIONAL (no existence guard): %s", sql)
	}
	if _, err := buildResyncSubscription("bad;name", conn, []string{"p"}); err == nil {
		t.Error("resync must reject an unsafe subscription name")
	}
}

func TestSlotStatusInvalid(t *testing.T) {
	for _, s := range []string{"lost", "LOST", " unreserved ", "unreserved"} {
		if !slotStatusInvalid(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
	for _, s := range []string{"reserved", "extended", "", "streaming"} {
		if slotStatusInvalid(s) {
			t.Errorf("%q should NOT be invalid", s)
		}
	}
	q := buildSlotStatusQuery("zone_sub_za")
	if !strings.Contains(q, "pg_replication_slots") || !strings.Contains(q, "'zone_sub_za'") {
		t.Errorf("slot-status query wrong: %s", q)
	}
}

func TestBuildDropSubscriptionDetachesSlotFirst(t *testing.T) {
	sql := buildDropSubscription("zone_sub_za")
	// The DISABLE + SET slot_name=NONE must precede DROP so a local drop never blocks
	// on an unreachable publisher (ADR-0007 §4d).
	iDisable := strings.Index(sql, "DISABLE")
	iNone := strings.Index(sql, "slot_name = NONE")
	iDrop := strings.Index(sql, "DROP SUBSCRIPTION")
	if !(iDisable >= 0 && iNone > iDisable && iDrop > iNone) {
		t.Errorf("drop-subscription order wrong (want DISABLE -> slot NONE -> DROP): %s", sql)
	}
}

func TestBuildDropReplicationSlotOnlyWhenInactive(t *testing.T) {
	sql := buildDropReplicationSlot("zone_sub_za")
	if !strings.Contains(sql, "NOT active") {
		t.Errorf("slot drop must guard on NOT active (never kill a live slot): %s", sql)
	}
	if !strings.Contains(sql, "'zone_sub_za'") {
		t.Errorf("slot drop must name the slot literally: %s", sql)
	}
}

func TestBuildEnsureReplRoleAssertsReplicationAndScramPassword(t *testing.T) {
	// issue #117: the repl role is set with its PLAINTEXT password under
	// password_encryption=scram-sha-256 so Postgres computes a SCRAM verifier
	// (no precomputed md5). The literal is single-quote-escaped.
	sql := buildEnsureReplRole("repl_za", "s3cr'et")
	for _, want := range []string{
		"SET password_encryption='scram-sha-256'",
		"CREATE ROLE \"repl_za\" WITH LOGIN REPLICATION",
		"ALTER ROLE \"repl_za\" WITH LOGIN REPLICATION",
		"PASSWORD 's3cr''et'", // quoteLiteral-escaped plaintext, NOT an md5 hash
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("repl-role SQL missing %q: %s", want, sql)
		}
	}
	if strings.Contains(sql, "md5") {
		t.Errorf("repl-role SQL must not carry an md5 verifier under SCRAM: %s", sql)
	}
}

func TestBuildEnsureFederationRejectsInjectionAndBuildsFDW(t *testing.T) {
	if _, err := buildEnsureFederation("za", "gw", 55432, "repl_za", "pw", []string{"bad name"}); err == nil {
		t.Fatal("expected federation to refuse an injection table name")
	}
	sql, err := buildEnsureFederation("za", "pggw-apps", 55432, "repl_za", "pw", []string{"public.customers"})
	if err != nil {
		t.Fatalf("federation: %v", err)
	}
	for _, want := range []string{
		"CREATE EXTENSION IF NOT EXISTS postgres_fdw",
		`CREATE SERVER "zone_fdw_za" FOREIGN DATA WRAPPER postgres_fdw`,
		"CREATE USER MAPPING FOR CURRENT_USER",
		`IMPORT FOREIGN SCHEMA public LIMIT TO ("customers") FROM SERVER "zone_fdw_za" INTO "zone_za"`,
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("federation SQL missing %q:\n%s", want, sql)
		}
	}
}

// ---- governance guards -----------------------------------------------------

func zoneWith(name string, pubs []Publication, deps []DataDependency) *Zone {
	return &Zone{Name: name, Spec: ZoneSpec{Publishes: pubs, DataDependencies: deps}}
}

func TestCheckBothSidesAgree(t *testing.T) {
	peer := zoneWith("za", []Publication{{Name: "p", Tables: []string{"orders", "order_lines"}}}, nil)
	// granted subset
	if u := checkBothSidesAgree(peer, []string{"orders"}); len(u) != 0 {
		t.Errorf("granted dependency should have no ungranted tables, got %v", u)
	}
	// ungranted table -> denial set
	u := checkBothSidesAgree(peer, []string{"orders", "customers"})
	if len(u) != 1 || u[0] != "customers" {
		t.Errorf("want [customers] ungranted, got %v", u)
	}
	// nil peer -> everything ungranted
	if u := checkBothSidesAgree(nil, []string{"orders"}); len(u) != 1 {
		t.Errorf("nil peer should deny all, got %v", u)
	}
}

// MANDATORY negative test: a table published by two zones is a single-writer violation.
func TestCheckSingleWriter_MultiPublisher(t *testing.T) {
	za := zoneWith("za", []Publication{{Name: "p", Tables: []string{"orders"}}}, nil)
	zb := zoneWith("zb", []Publication{{Name: "q", Tables: []string{"orders"}}}, nil)
	if v := checkSingleWriter(za, []*Zone{za, zb}); v == "" {
		t.Fatal("expected a single-writer violation when two zones publish the same table")
	}
	// A clean namespace (each table single-published) passes.
	zbClean := zoneWith("zb", []Publication{{Name: "q", Tables: []string{"customers"}}}, nil)
	if v := checkSingleWriter(za, []*Zone{za, zbClean}); v != "" {
		t.Errorf("unexpected violation for single-publisher tables: %s", v)
	}
}

// MANDATORY negative test: a zone that both publishes AND replicate-imports a table
// (writes it locally while importing a replicated copy) is a single-writer violation.
func TestCheckSingleWriter_ImportWhatYouPublish(t *testing.T) {
	self := zoneWith("zb",
		[]Publication{{Name: "p", Tables: []string{"orders"}}},
		[]DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeReplicate}},
	)
	za := zoneWith("za", []Publication{{Name: "q", Tables: []string{"orders"}}}, nil)
	if v := checkSingleWriter(self, []*Zone{self, za}); v == "" {
		t.Fatal("expected a violation: a zone must not replicate-import a table it also publishes/writes")
	}
	// federate mode is NOT a local write of the table, so it is allowed.
	selfFed := zoneWith("zb",
		[]Publication{{Name: "p", Tables: []string{"widgets"}}},
		[]DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeFederate}},
	)
	if v := checkSingleWriter(selfFed, []*Zone{selfFed, za}); v != "" {
		t.Errorf("federate import should not trip the single-writer guard: %s", v)
	}
}

// MANDATORY: a zone that replicate-imports a table published by MORE THAN ONE peer is
// a single-writer violation even though the importer itself publishes nothing (the
// X-imports-T-while-A+B-both-publish-T case).
func TestCheckSingleWriter_ImportFromMultiplePublishers(t *testing.T) {
	a := zoneWith("a", []Publication{{Name: "p", Tables: []string{"orders"}}}, nil)
	b := zoneWith("b", []Publication{{Name: "q", Tables: []string{"orders"}}}, nil)
	x := zoneWith("x", nil, []DataDependency{{FromZone: "a", Tables: []string{"orders"}, Mode: ModeReplicate}})
	if v := checkSingleWriter(x, []*Zone{a, b, x}); v == "" {
		t.Fatal("expected a violation: importing a table published by >1 zone (ambiguous writer)")
	}
	// Single publisher is fine for the importer.
	bOther := zoneWith("b", []Publication{{Name: "q", Tables: []string{"widgets"}}}, nil)
	if v := checkSingleWriter(x, []*Zone{a, bOther, x}); v != "" {
		t.Errorf("single-publisher import should be clean: %s", v)
	}
}

func TestPubsCovering(t *testing.T) {
	peer := zoneWith("za", []Publication{
		{Name: "orders_pub", Tables: []string{"orders", "order_lines"}},
		{Name: "cust_pub", Tables: []string{"customers"}},
	}, nil)
	got := pubsCovering(peer, []string{"orders"})
	if len(got) != 1 || got[0] != "orders_pub" {
		t.Errorf("want [orders_pub], got %v", got)
	}
	got = pubsCovering(peer, []string{"orders", "customers"})
	if len(got) != 2 || got[0] != "cust_pub" || got[1] != "orders_pub" {
		t.Errorf("want [cust_pub orders_pub] (sorted), got %v", got)
	}
}

func TestZoneMD5MatchesFormat(t *testing.T) {
	// raw 32-hex, no md5 prefix (compute_ctl encrypted_password format).
	got := zoneMD5("pw", "repl_za")
	if len(got) != 32 {
		t.Errorf("zoneMD5 len=%d want 32 (%s)", len(got), got)
	}
}
