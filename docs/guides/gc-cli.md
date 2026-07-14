# `kn-next gc` — asset retention GC & skip-reason tokens

`kn-next gc` runs the skew-protection asset retention GC (ADR-0011): it reaps
old `_next/static/<build-id>/` prefixes from the object store while keeping the
newest `storage.assetRetention` builds, every build currently serving traffic,
and the build of any pinned (`spec.traffic.revisionName`) revision. It reads the
cluster **read-only** and only ever deletes under the app's own
`<app>/_next/static/<id>/` prefix.

The GC is **fail-safe**: whenever it cannot prove a build is safe to reap it
**skips entirely** (over-keep, never over-delete) and prints a single line:

```
gc: SKIPPED (fail-safe over-keep) [<token>] — <human-readable reason>
```

## Skip-reason tokens (stable machine-readable contract)

The `[<token>]` suffix is a **stable, machine-readable contract**. It is safe to
match on in alerts, dashboards, and runbooks — these tokens are treated like an
enum and are **not renamed casually**; renaming one is a breaking change. The
full set is exhaustive (the renderer fails to compile if a new skip cause is
added without its own token), and this table is kept in lock-step with the code
by a contract test.

| Token | Meaning |
| --- | --- |
| `[pinned-with-empty-status]` | `status.currentTraffic` is empty while the CR pins a revision (`spec.traffic.revisionName`), or the pin probe itself failed with an empty status. A window-only prune could reap the pinned build, so the GC skips. |
| `[pinned-not-resolvable]` | With a non-empty (possibly lagging) status, the pin probe threw (we cannot prove there is no pin), or the pinned revision's build-id cannot be resolved (revision gone, build-id label absent, or the read failed). |
| `[unresolvable-live-build-id]` | A live revision has no resolvable `apps.kn-next.dev/build-id` label (missing, empty, or the read threw), so a live build cannot be proven protected. |

### First-cause precedence

When more than one skip condition holds at once, the token reflects the **first
cause checked**, in this order (highest precedence first):

1. `[pinned-with-empty-status]`
2. `[pinned-not-resolvable]`
3. `[unresolvable-live-build-id]`

For example, if the spec-pin probe throws **and** a live revision's build-id
label is also unresolvable, the emitted token is `[pinned-not-resolvable]` (the
pin skip is decided before any per-revision label resolution). Consumers keying
on these tokens can rely on this ordering.
