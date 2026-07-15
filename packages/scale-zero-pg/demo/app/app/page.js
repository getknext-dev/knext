import { getDbPool } from "../lib/db";

// Never statically render or cache: every request must actually hit Postgres so
// the scale-to-zero wake path is exercised on each visit.
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function loadVisit() {
  const pool = getDbPool();
  const startedAt = Date.now();

  // Idempotent schema — the first visitor after a fresh DB creates the table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id      bigserial PRIMARY KEY,
      seen_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // One INSERT (the "visit counter") + one SELECT (now() + total count).
  const inserted = await pool.query(
    "INSERT INTO visits DEFAULT VALUES RETURNING id, seen_at",
  );
  const summary = await pool.query(
    "SELECT count(*)::bigint AS total, now() AS db_now, version() AS pg_version FROM visits",
  );

  const dbElapsedMs = Date.now() - startedAt;
  const row = summary.rows[0];
  return {
    ok: true,
    visitId: inserted.rows[0].id,
    total: row.total,
    dbNow: row.db_now,
    pgVersion: row.pg_version,
    dbElapsedMs,
  };
}

export default async function Page() {
  let data;
  try {
    data = await loadVisit();
  } catch (err) {
    data = { ok: false, error: String(err && err.message ? err.message : err) };
  }

  return (
    <main style={{ maxWidth: 720, lineHeight: 1.6 }}>
      <h1 style={{ color: "#7ee787" }}>scale-to-zero pg demo</h1>
      <p>
        A knext <code>NextApp</code> (Knative scale-to-zero) talking to a
        scale-to-zero Postgres (<code>pggw.scale-zero-pg</code>). Both sleep at
        rest; this page woke them.
      </p>

      {data.ok ? (
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            <Row k="visit #" v={String(data.visitId)} />
            <Row k="total visits" v={String(data.total)} />
            <Row k="db now()" v={new Date(data.dbNow).toISOString()} />
            <Row k="db round-trip" v={`${data.dbElapsedMs} ms`} />
            <Row k="server" v={String(data.pgVersion).split(" on ")[0]} />
          </tbody>
        </table>
      ) : (
        <pre style={{ color: "#ff7b72" }}>DB error: {data.error}</pre>
      )}

      <p style={{ opacity: 0.6, marginTop: "2rem", fontSize: "0.85rem" }}>
        Pool mirrors <code>@knext/lib</code> getDbPool: max 5, idle 10s (&lt;
        gateway 60s idle window). Idle → both scale to zero → next visitor wakes
        both.
      </p>
    </main>
  );
}

function Row({ k, v }) {
  return (
    <tr>
      <td style={{ padding: "4px 16px 4px 0", opacity: 0.7 }}>{k}</td>
      <td style={{ padding: "4px 0", color: "#79c0ff" }}>{v}</td>
    </tr>
  );
}
