# ADR-0063: pre-GA release lines live on integration branches, not main

- **Status:** **Accepted (2026-10-03).** Founder-delegated decision. The founder delegated the
  choice between options (a)/(b) below to `jev`; it scored (a) "integration branch" 0.99 vs.
  (b) "land on main, cut 1.0.0 from a `release/1.0` branch" 0.01. Recording that decision as this
  ADR is a separate, later decision — also run through `jev` — which scored 0.58. Trigger-class
  (ADR — a release-line branching decision, founder-delegated, 2026-10-03), reviewed per
  `.claude/rules/workflow.md`'s sprint-close process; not a merge gate.
- **Amended:** 2026-10-09 — the v2 line, dist-tags, `release/1.x`, 1.x support window (see the
  amendment at the end).
- **Relates to:** `CLAUDE.md` §9 (as-built truths on publishing/versioning), ADR-0036 (two build
  targets — the 1.3 line carries vinext/Bun patch work that is separate from the v1.0 GA line),
  and the published-bytes-freeze invariant enforced by
  `scripts/lib/published-bytes-freeze-check.mjs`. Does not amend ADR-0001 or any runtime ADR —
  this is a release-process decision only.
- **Issues/PRs this records:** #1817, #1819, #1820, #1821, #1823, #1824, #1825, #1826, #1828.

## Context

v1.0 GA is not cut yet: `main` is still on the v1.0.0-rc.5 bytes, published to the npm dist-tag
`rc` (`.changeset/pre.json` on `main` carries `"tag": "rc"`). In parallel, a batch of vinext/Bun
work landed — scaffold pin bump (#1817), a glibc smoke-only sharp fix (#1819), bundling six
upstream vinext fixes as knext-applied patches (#1821), an opt-in knext-patched Bun toolchain
(#1823), `compile.include` for embedding extra modules (#1826), and the public-site domain rename
(#1824, #1825) — plus two release PRs (#1820, #1828) that publish this
work as the `1.3.0-rc.1` line to the npm dist-tag `next`.

That work needed a home. Landing it straight on `main` would mix two concerns that must stay
separable until GA: (1) the frozen v1.0.0-rc.5 → v1.0.0 delta, which must be **version-only** —
no other published-bytes change — and (2) the 1.3 line's real code changes, which are
published-bytes changes by definition. The existing freeze guard
(`scripts/lib/published-bytes-freeze-check.mjs`, `OVERRIDE_MARKER_FIELD =
'publishedBytesBumpMarker'`) can be satisfied by a reviewed-PR override marker, but today that
marker has **no `paths` field** — it exempts the *entire* PR's published-bytes diff, not a scoped
subset. If the 1.3 line's commits reached `main` under one such marker, every published-bytes
change in that PR would be exempted, including ones unrelated to the marker's stated reason. One
such marker already exists with an expiry of **2026-10-10**.

Separately, `.changeset/pre.json` on the 1.3 work is in `pre` mode with `"tag": "next"` — a
different dist-tag than `main`'s `"rc"` — and a test (`tests/ensure-published-group.test.ts`-style
discipline, extended for this line) pins that tag so the 1.3 line cannot accidentally publish onto
`rc` or `latest` while v1.0 has not shipped.

## Decision

**Pre-GA release lines live on integration branches, published from there, not from `main`.**

- `integration/v1.3` carries the 1.3.0-rc.1 line and everything that follows it until GA, and
  publishes to the npm dist-tag `next`.
- `main` stays on the v1.0.0-rc.5 bytes until 1.0.0 GA is cut. No commit that changes published
  bytes lands on `main` before then, outside the version-only GA bump itself.
- **`integration/v1.3` must NOT merge into `main` before 1.0.0 GA is cut**, for three concrete
  reasons:
  1. the GA tarball must equal the v1.0.0-rc.5 bytes — a **version-only** delta — and merging in
     the 1.3 line's real code changes would break that equivalence;
  2. the integration branch carries a `publishedBytesBumpMarker` override with **no `paths`
     field**, expiring **2026-10-10** — if that branch (and marker) reached `main`, it would
     exempt every published-bytes change in scope, not just the one it was written for;
  3. its `.changeset/pre.json` `tag` is `"next"`, which a test pins — merging that state into
     `main` before GA would misroute `main`'s next publish to the wrong dist-tag.

**After GA**, merge `integration/v1.3` into `main` with a plain merge commit (no rebase), and in
that same PR:
- reset `.changeset/pre.json` and the version mechanics for the 1.x line (exit `pre` mode or
  re-enter it correctly for 1.1-dev, as appropriate at that point);
- delete the `next`-tag pin block in `tests/ensure-published-group.test.ts`;
- drop any expired override markers (the 2026-10-10 one and any others accumulated meanwhile);
- **keep the required CI check names unchanged** — a rename blocks merges, as #1824 showed when
  the public-site domain rename touched check-name-adjacent surface.

## Options considered

| Option | Description | Trade-offs | jev score |
|---|---|---|---|
| **(a) Integration branch** *(chosen)* | New code (1.3 line) lives on `integration/v1.3`, publishes to `next`; `main` stays frozen at rc.5 bytes until GA, then one merge commit folds the line in. | + Clean separation: GA diff on `main` stays version-only and auditable. + The `next`-tag pin and the no-`paths` override marker are quarantined to a branch that is explicitly not GA-bound, instead of being a live hazard on `main`. + No rebase needed post-GA (merge commit preserves the 1.3 line's own history). − Two branches to keep in sync conceptually; a human must remember not to fast-forward `main` onto it. − The post-GA merge is itself a checklist item that must not be skipped or done carelessly (CI check-name rename is a proven failure mode, #1824). | **0.99** |
| **(b) Land on main, cut 1.0.0 from a `release/1.0` branch** | Let the 1.3 work land on `main` as it's ready; branch `release/1.0` off `main` at the rc.5 commit to cut GA from, keeping `main` itself free to move forward. | + Only one branch (`main`) carries "current" work; no merge-back step needed later. − Inverts the usual release-branch convention (normally the *stable* line is isolated, not the experimental one) — reviewers and tooling expect `main` to be closest to shippable. − The published-bytes freeze guard is written against `main`'s diff; it would need rescoping to `release/1.0` instead, and the override-marker/no-`paths` hazard moves to being a live risk on `main` rather than quarantined. − `release/1.0` becomes a second thing to remember to delete/retire after GA, with no corresponding checklist discipline already in place. | **0.01** |

The founder delegated the choice to `jev`; (a) scored overwhelmingly higher (0.99 vs 0.01) and is
the one actually implemented (`integration/v1.3` exists and `1.3.0-rc.1` is already published to
`next`), so this ADR records the decision as made, not as a forward-looking recommendation. Writing
that decision down as this ADR is itself a separate, later call — `jev` scored doing so now at
0.58.

## Consequences

- `main` remains safe to read as "the v1.0 GA candidate" at any point before GA — no published-bytes
  drift from the 1.3 line can leak in through a careless merge, because the integration branch is
  the only place that line's commits exist pre-GA.
- The post-GA merge of `integration/v1.3` is now a **named, non-trivial** event with its own
  checklist (pre.json reset, test-pin deletion, marker cleanup, check-name stability) rather than
  an ordinary feature-branch merge — anyone running it must read this ADR first.
- The no-`paths` override marker's scope is a known, accepted gap for now, confined to a branch
  that will not merge into `main` before its 2026-10-10 expiry passes (it will need renewal or
  retirement on the integration branch itself if GA slips past that date — not a `main`-side
  concern).
- Nothing here blocks GA on `main`: the v1.0.0-rc.5 → v1.0.0 version-only bump can proceed
  independently of when `integration/v1.3` is ready to merge.

## Action items

1. **Gate tech-debt item:** make `publishedBytesBumpMarker` require a `paths` field, so a future
   override marker can exempt only the files it names rather than a PR's entire published-bytes
   diff. File as a sprint-close tech-debt backlog item against
   `scripts/lib/published-bytes-freeze-check.mjs`.
2. **Mechanical guard against an early merge** (e.g. a CI check on `main` that fails if
   `integration/v1.3`'s tip is reachable from `main` before a GA marker exists) was considered and
   **declined for now** — jev scored building it today at only 0.35, i.e. the manual checklist
   below is judged sufficient given how close GA is and how few people can merge into `main`. Revisit
   if GA slips materially or the merge responsibility widens.
3. **Post-GA merge checklist** (to run in the single PR that merges `integration/v1.3` → `main`):
   - [ ] Merge `integration/v1.3` into `main` with a plain merge commit — no rebase.
   - [ ] Reset `.changeset/pre.json` and the version mechanics for the 1.x line.
   - [ ] Delete the `next`-tag pin block in `tests/ensure-published-group.test.ts`.
   - [ ] Drop any expired `publishedBytesBumpMarker` overrides carried by the integration branch.
   - [ ] Keep every required CI check name byte-identical through the merge — verify in
     branch-protection settings before and after, not just by eye on the diff (#1824 precedent).

## Amendment (2026-10-09) — the v2 line, dist-tags, `release/1.x` and the 1.x support window

**Status of this amendment: Accepted.** It records founder decisions taken on 2026-10-09 (v2 plan
Q3, Q4, Q5, Q7, Q8; jev scores below) after the architect and system-designer gates signed off the
plan. The original decision (integration branches, not `main`, for pre-GA lines) stands unchanged;
this extends the same pattern to the next major. Trigger-class (ADR); per the 2026-09-22 workflow
amendment it is reviewed at sprint close, not as a merge gate.

### Context

`integration/v1.3` is the line that merges to `main` at 1.3 GA (the original action items). The v2
plan adds a 1.4 line (platform layer plus deprecations), a 2.0 line (contract cleanup plus zone
functions at Beta), and a promise to keep fixing 1.x after 2.0. Without a recorded model, the next
person to cut a pre-release picks a tag and a branch by guesswork — the same failure mode that
produced the accidental `2.0.0` computation from a stale pre-mode marker on 242 branches.

### Decision

**Lines and branches**

| Line | Branch | Pre-release tag | GA tag |
|---|---|---|---|
| 1.3 (current GA) | `integration/v1.3`, merged to `main` (the original action items) | `next` | `latest` |
| 1.4 (platform layer, deprecations) | `integration/v1.4` | `next-1.4` | `latest` until 2.0 GA, then `latest-1` |
| 2.0 | `integration/v2`, cut from `main` after the 1.3 merge | `next` (once 1.3 vacates it) | `latest` |
| 1.x maintenance | **`release/1.x`**, cut from the 1.x tip at 2.0 GA | none | `latest-1` |
| 1.0 | frozen | `rc` | `latest-1.0` (a dist-tag a maintainer must add; none exists today) |

- **Dist-tags:** `latest` (newest stable), `latest-1` (newest stable 1.x, after 2.0 GA), `next`
  (the line currently in pre-release). `next-1.4` is the pre-release channel for the 1.4 line while
  `next` still carries 1.3. None of these is a semver range, so npm accepts them.
- **`release/1.x`** is a new publish lane, cut at 2.0 GA from the 1.x tip. It carries **security
  and critical fixes only**; it never takes features.
- **Support window: six months, security-only, for 1.x, counted from 2.0 GA.** It replaces the
  "no backport branches" stance of `docs/RELEASE_POLICY.md`, which stays true until 2.0 GA. After
  six months `release/1.x` is frozen and `latest-1` stops moving. jev: 6-month security-only 0.80,
  none 0.19, 12-month 0.01.
- **v1.0 credentials retire at 2.0 GA.** The v1.0 credential lane stops; the four 2.0 cells take the
  v1.3 lane's cron slots, and 1.x gets no new credential. Net slot count never exceeds today's.
- **Forward-merge discipline:** the newest 1.x line (later `release/1.x`) is merged into
  `integration/v2` before every 2.0 release candidate, so no 1.x fix is missing from 2.0.
- **Publish allowlist:** a publish may run only from an exact, glob-free ref list (`main`,
  `integration/v1.3`, `integration/v1.4`, `integration/v2`, `release/1.x`), with a runtime check that
  the computed major matches the lane's expected major. Adding a lane is a reviewed edit to that
  list. Moving `latest` or `latest-1` needs a required reviewer on a separate environment.
- **Ordering:** `2.0.0-rc.1` does not publish until 1.4.0 is released, so the deprecation notices
  reach users in a release that still has the old behaviour (`RELEASE_POLICY.md` deprecation rule).

### Consequences

- Two more long-lived branches (`integration/v2`, `release/1.x`) and one more publish lane to
  protect; the allowlist and the major check are what keep that safe.
- The 1.x support promise is bounded and security-only; anything wider is a new decision.
- `docs/RELEASE_POLICY.md`, `SECURITY.md` and the versioning docs page are updated to state the
  window and the lane model; the ADR-0020 amendment of the same date covers the package set.

### Action items

- [ ] Cut `integration/v2` and enter changesets pre mode with tag `next` (after the 1.3 merge).
- [ ] Create `release/1.x` and its publish lane at 2.0 GA; add `latest-1` to the rollback scripts.
- [ ] Founder: add the `latest-1.0` dist-tag; run `npm deprecate kn-next@"<2"` at 2.0 GA.
