---
"@knext/db": minor
"@knext/core": minor
---

feat(db): `kn-next db migrate` one-shot migration runner + Job recipe (ADR-0021 §3)

Completes the `@knext/db/migrate` surface with the writer-only migration runner.

- **`@knext/db/migrate` → `runMigrations(options?, deps?)`** applies
  drizzle-kit-generated migrations against the **writer** (`DATABASE_URL`) via
  drizzle-orm's node-postgres migrator, then exits. It resolves + guards the DSN
  (`resolveWriterDsn`): it **refuses** a read-replica DSN — an exact
  `DATABASE_URL_RO`, or any DSN on the RO gateway port `55434` — because
  single-writer forbids writes on the replica. Idempotent (drizzle tracks applied
  migrations) and **fail loud** (rejects on error; the connection is always
  closed). `pg` is now a runtime dependency of `@knext/db`.
- **`kn-next db migrate`** wraps it as a CLI subcommand — run it once per deploy
  (a CI step or a pre-deploy k8s Job), out of the request path, never on pod boot
  and never operator-run. A failure exits non-zero so a Job fails loudly.
- **Docs:** the `@knext/db` README gains a migrations section, the "running
  migrations for a NextApp" flow, and a one-shot **Job recipe** (writer-only,
  `restartPolicy: Never`, sequenced after the `AppDatabase` is `Ready`).
