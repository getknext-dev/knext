# Mutation testing: how to prove a guard, and how to get your tree back

Every new guard in this repo is mutation-proved: delete the behaviour it protects, watch it go
RED, restore. A guard that stays green when its subject is removed is decoration.

The proof is not the risky part. **The restore is.** Two incidents in one session (#645) each came
within a commit of shipping the inverse of the fix the PR described:

1. An agent stalled *between* mutate and restore. A live mutation was left in `status_verdict.go`
   that re-enabled the exact behaviour the PR existed to remove.
2. A harness restored **two** edits to one file by replaying the inverse edits in **forward order**.
   The first inverse edit reinstated the *intermediate* state, the second then matched nothing, and
   a live mutation survived.

Both were caught by luck. Neither would have been caught by the check the practice recommended.

## `git status --porcelain` is not sufficient

It is only sufficient for a file the change does **not** otherwise touch. If your PR legitimately
modifies the file you mutated, the file reads `M` either way — the residue hides inside an expected
modification, and the check proves nothing. Do not rely on it as the mutation-safety gate; use the
two tools below.

## 1. The residue scan (the gate)

```bash
pnpm run lint:mutation-residue        # node scripts/scan-mutation-residue.mjs
```

Exit 1 if **any tracked file** contains the standard mutation marker. It never consults git's
status, so a legitimately-modified file gives it no cover. It runs in CI (`Lint & Test`) as a
red-on-fail step, so unrestored residue cannot merge.

The marker is the repo-namespaced token `KNEXT` + `-MUTATION` (written here as a concatenation on
purpose — see below). A bare `MUTATION` was rejected as the marker: it occurs legitimately in
GraphQL code, `useMutation`, and minified bundles, so a scan for it would be noise, and a noisy
scan trains people to ignore it.

Two deliberate properties:

- **No allowlist.** An exemption mechanism is how a real hit gets silenced.
- **The scan does not flag itself.** The literal marker string appears in *no* tracked file. The
  harness assembles it from parts, and the scanner imports it. You should never need to type it:
  `mutate()` emits it for you.

The scan reads the file set from `git ls-files`. That is what excludes `node_modules/` and build
output — a naive repo-wide grep matches minified vendor bundles. Known gap, stated rather than
hidden: residue in an **untracked** file is not reported.

## 2. The snapshot harness (how to mutate)

`scripts/lib/mutation-harness.mjs` — use it instead of hand-rolling `sed`/`perl` edits.

```js
import { snapshot, mutate, restore } from './lib/mutation-harness.mjs';

const snap = snapshot('internal/controller/status_verdict.go'); // BYTES, before the first mutation
mutate(snap, 'return app.Spec.Revalidation != nil', 'return true');
mutate(snap, 'var NORMALIZED = []string{"a"}', 'var NORMALIZED = []string{}');
// ...run the guard, require RED...
restore(snap); // writes the snapshotted bytes back; NEVER replays inverse edits
```

What it guarantees:

- **Content-addressed restore.** `restore()` writes the snapshotted bytes and verifies the sha256
  of the result. Incident 2 is impossible by construction — order of mutations cannot matter when
  the restore does not depend on it.
- **Anchor counting at every stage.** `mutate()` refuses unless the anchor occurs **exactly once**,
  and refuses a substitution that changes nothing. A silently-failed substitution yields a green run
  that proves nothing, which is worse than a red one.
- **Anchors re-asserted after restore.** Every anchor used during the proof must occur exactly once
  again, or `restore()` throws. The bytes are put back first regardless — a failed re-assertion is a
  report, never a reason to leave a mutated file on disk.
- **Every mutation is marked.** Residue from a stalled proof (incident 1) is findable by the scan.
  Passing `mark: false` is only allowed if your replacement already embeds the marker; otherwise the
  harness refuses to create residue nothing can detect.

There is a CLI for non-Node harnesses (the operator's bash harness), which carries the snapshot
between processes as a JSON file:

```bash
H=scripts/lib/mutation-harness.mjs
node $H snapshot test/utils/diagnose.go /tmp/snap.json
node $H mutate   /tmp/snap.json 'case schemaSkewRe.MatchString(msg):' 'case false:'
go test ./test/utils/ && echo 'DECORATION: stayed green' && exit 1
node $H restore  /tmp/snap.json
```

## Proving the guards themselves

`node scripts/mutation-prove-residue-scan.mjs` mutation-proves both of the above — and dogfoods the
harness while doing it, restoring from the snapshot it is proving. Its last step is the issue in
miniature: it plants residue in a file that is *also* legitimately modified, prints
`git status --porcelain` reporting **the identical thing either way**, and shows the scan going red
regardless.

Three more standing proofs, each covering a guard whose subject is absent from a clean tree — the
shape most likely to be decoration, because nothing on the happy path ever exercises it:

- `node scripts/mutation-prove-blocking-gate.mjs` — removes each detection from the blocking-gate
  audit engine (`tests/helpers/blocking-gate.ts`) and requires its spec to red.
- `node scripts/mutation-prove-ci-blocking-gates.mjs` — the other direction, on the real workflow:
  disarms each guarded `ci.yml` job five ways (`"if": false`, `'if': false`,
  `continue-on-error: ${{ true }}`, `needs:` on a skippable job, a zero-expansion `strategy:`) and
  requires the guard that calls it a blocking gate to red. It runs only the one assertion by name,
  because one of those specs also scans for the residue marker the harness plants and would
  otherwise red for its own reason.
- `node scripts/mutation-prove-stale-pointer-scan.mjs` — plants an ambiguous bare test-file
  reference, discovering a duplicated basename from `git ls-files` rather than hardcoding one.

## Checklist

- Snapshot bytes before the first mutation.
- Never replay inverse edits.
- Assert each anchor occurs exactly once — before mutating and after restoring.
- Run `pnpm run lint:mutation-residue` before you commit. Do not substitute `git status`.
