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
| `[traffic-drift-during-plan]` | The pin or `status.currentTraffic` changed between the GC plan and the first delete (or the pre-delete re-read failed). The GC re-reads once immediately before deleting; any drift aborts the deletes so a build made live/pinned mid-run is never reaped. |

### First-cause precedence

When more than one skip condition holds at once, the token reflects the **first
cause checked**, in this order (highest precedence first):

1. `[pinned-with-empty-status]`
2. `[pinned-not-resolvable]`
3. `[unresolvable-live-build-id]`
4. `[traffic-drift-during-plan]`

For example, if the spec-pin probe throws **and** a live revision's build-id
label is also unresolvable, the emitted token is `[pinned-not-resolvable]` (the
pin skip is decided before any per-revision label resolution). Consumers keying
on these tokens can rely on this ordering.

`[traffic-drift-during-plan]` has the **lowest precedence**: it is only
reachable once the plan has already resolved to a concrete, prunable delete set
(all three fail-safes above passed), and it is checked last, immediately before
the first delete. It is the only skip driven by a **second** observation of the
cluster — a re-read of the pin + `status.currentTraffic`. The re-read
**narrows, but does not eliminate,** the time-of-check/time-of-use window: a
change after the second read and before the physical delete is still possible
(object stores offer no atomic compare-and-delete across a set). It can only
ever make the GC more conservative (abort/keep), never delete something the
plan would have kept.
