# @knext/core

## 0.3.0

### Minor Changes

- 6e9c713: Add a public `@knext/core/validate` subpath.

  `validateConfig` (and its `ConfigValidationError` result type) are now a
  supported public import. Use them as a config-quality gate in your own CI to
  validate a `kn-next.config.ts` against the exact rules the deploy step applies,
  before a bad config reaches the cluster:

  ```ts
  import { validateConfig, ConfigValidationError } from "@knext/core/validate";
  ```

  The module is pure — importing it runs no I/O and never exits the process — so
  it is safe to pull into your own build/test process. The previous
  `@knext/core/internal/cli-validate` subpath remains for internal CLI wiring but
  carries no stability guarantee; prefer the public `@knext/core/validate`.

### Patch Changes

- Updated dependencies [2c156a7]
  - @knext/db@0.2.1

## 0.2.0

### Minor Changes

- e6288df: feat(db): `kn-next db migrate` one-shot migration runner + Job recipe (ADR-0021 §3)

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

### Patch Changes

- Re-release the full three-package set: `@knext/db` joins the published packages
  (`@knext/core` depends on it for `kn-next db migrate`), so all three bump
  together and ship as a set — publishing core without db breaks every consumer
  install with a 404 on the missing member.
- Updated dependencies [9810a00]
- Updated dependencies [dd20ad2]
- Updated dependencies [e6288df]
- Updated dependencies [49a48e4]
- Updated dependencies [82ddbef]
- Updated dependencies
  - @knext/db@0.2.0
  - @knext/lib@0.2.0
