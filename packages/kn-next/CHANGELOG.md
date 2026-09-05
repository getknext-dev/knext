# @getknext/core

## 0.4.0

### Minor Changes

- a450c9f: BREAKING (default metrics port): the app metrics port default moves from 9091
  to 9464 (#951). Anything OUTSIDE knext that scrapes the old port goes dark on
  upgrade — hand-rolled Prometheus scrape configs, ServiceMonitors/PodMonitors
  you wrote yourself, Grafana datasource queries pinned to `:9091`, and
  NetworkPolicies you added alongside knext's must all be repointed to `:9464`
  (knext's own annotation, NetworkPolicy, PodMonitor and dashboards move
  automatically). See the "Upgrading" docs page for the ordered steps and the
  verification command.
  
  Why: on a stock Knative
  Serving install (default `config-observability`), the queue-proxy sidecar binds
  `:9091` in every revision pod for its own user-metrics server, so an app
  defaulting to 9091 lost the port race and crash-looped with `EADDRINUSE`. The
  runtime entries' `METRICS_PORT` default, the operator's `prometheus.io/port`
  annotation, the default NetworkPolicy's metrics-scrape grants and the shipped
  PodMonitor all move to 9464 together (locksteped by
  `metrics-port-lockstep.test.ts`), and `kn-next doctor` now detects the
  collision condition (queue-proxy user metrics active + an app pinned onto
  `METRICS_PORT=9091`) and says how to resolve it. Upgrade order matters as
  always (#548): operator/CRD first, then CLI — a new runtime image scraped by an
  old operator (or vice versa) scrapes the wrong port until both sides are on the
  same release.

### Patch Changes

- @getknext/db@0.4.0
  - @getknext/lib@0.4.0

## 0.3.1

### Patch Changes

- bf03457: Version the three published packages in lockstep.
  
  `@getknext/core` depends on `@getknext/lib` and `@getknext/db`, so the three have always had to
  ship as a set — but that was a documented intention, and the tree had already drifted to three
  different numbers. They are now a Changesets `fixed` group, so every release moves all three to the
  same version, and a guard fails if they diverge or if a fourth publishable package appears.
  
  No API change. From this release on, pinning `@getknext/core@x.y.z` pins the whole set.
- 588d1ef: The operator's default NetworkPolicy now restricts ingress **ports**, and scopes same-namespace
  access to metrics only.
  
  Previously the policy allowed any admitted source to reach **any port** on your app's pods. In
  practice that meant a pod sharing your namespace could dial your app container directly, bypassing
  the Knative queue-proxy — and with it your app's concurrency limit and one layer of HTTP parsing.
  
  The policy now admits the queue-proxy ports (`8012`/`8013`, and `8112` for Knative's internal
  TLS path) and the metrics ports (`9090`, `9091`)
  from `knative-serving`/`kourier-system`, and the **metrics ports only** from same-namespace pods.
  Your app's container port is deliberately excluded — the queue-proxy reaches it over pod-local
  loopback, which no NetworkPolicy governs.
  
  **Behaviour change.** If something in your namespace called your app directly on its container
  port, that call now fails. Call the app through its service URL instead (gateway-routed, still
  allowed), or opt out with `spec.security.networkPolicy: false`.
  
  **Enforcement depends on your CNI.** Calico and Cilium enforce NetworkPolicy; flannel ships no
  policy controller, so on a flannel cluster this object is declarative only and changes nothing.
- Updated dependencies [bf03457]
  - @getknext/lib@0.3.1
  - @getknext/db@0.3.1

## 0.3.0

### Minor Changes

- 6e9c713: Add a public `@getknext/core/validate` subpath.

  `validateConfig` (and its `ConfigValidationError` result type) are now a
  supported public import. Use them as a config-quality gate in your own CI to
  validate a `kn-next.config.ts` against the exact rules the deploy step applies,
  before a bad config reaches the cluster:

  ```ts
  import {
    validateConfig,
    ConfigValidationError,
  } from "@getknext/core/validate";
  ```

  The module is pure — importing it runs no I/O and never exits the process — so
  it is safe to pull into your own build/test process. The previous
  `@getknext/core/internal/cli-validate` subpath remains for internal CLI wiring but
  carries no stability guarantee; prefer the public `@getknext/core/validate`.

### Patch Changes

- Updated dependencies [2c156a7]
  - @getknext/db@0.2.1

## 0.2.0

### Minor Changes

- e6288df: feat(db): `kn-next db migrate` one-shot migration runner + Job recipe (ADR-0021 §3)

  Completes the `@getknext/db/migrate` surface with the writer-only migration runner.

  - **`@getknext/db/migrate` → `runMigrations(options?, deps?)`** applies
    drizzle-kit-generated migrations against the **writer** (`DATABASE_URL`) via
    drizzle-orm's node-postgres migrator, then exits. It resolves + guards the DSN
    (`resolveWriterDsn`): it **refuses** a read-replica DSN — an exact
    `DATABASE_URL_RO`, or any DSN on the RO gateway port `55434` — because
    single-writer forbids writes on the replica. Idempotent (drizzle tracks applied
    migrations) and **fail loud** (rejects on error; the connection is always
    closed). `pg` is now a runtime dependency of `@getknext/db`.
  - **`kn-next db migrate`** wraps it as a CLI subcommand — run it once per deploy
    (a CI step or a pre-deploy k8s Job), out of the request path, never on pod boot
    and never operator-run. A failure exits non-zero so a Job fails loudly.
  - **Docs:** the `@getknext/db` README gains a migrations section, the "running
    migrations for a NextApp" flow, and a one-shot **Job recipe** (writer-only,
    `restartPolicy: Never`, sequenced after the `AppDatabase` is `Ready`).

### Patch Changes

- Re-release the full three-package set: `@getknext/db` joins the published packages
  (`@getknext/core` depends on it for `kn-next db migrate`), so all three bump
  together and ship as a set — publishing core without db breaks every consumer
  install with a 404 on the missing member.
- Updated dependencies [9810a00]
- Updated dependencies [dd20ad2]
- Updated dependencies [e6288df]
- Updated dependencies [49a48e4]
- Updated dependencies [82ddbef]
- Updated dependencies
  - @getknext/db@0.2.0
  - @getknext/lib@0.2.0
