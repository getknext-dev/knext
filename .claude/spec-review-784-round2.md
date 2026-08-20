# Spec review round 2 — PR #784 @ f4e2035 vs issue #764 (ADR-0042 C6)

Round 1 verdict: ISSUES_FOUND — all three acceptance criteria met by tested behaviour, three
documentation-of-residual-obligation findings (A: cosign-attestation half of C6 unrecorded;
B: stale ADR lines reading as though the gate is unbuilt; C: single-closure scope unstated).

Re-verified against `git diff 9050f50 f4e2035` (9 files, +432/−98) and a live test run.

## The three findings

**A — the cosign-attestation half of C6 is now recorded as OWED, in all three places. RESOLVED.**
- `docs/security/threat-model.md`, new **"What is still owed"** paragraph: "That scan guards
  **ordering only**… the SBOM must be attached to the published image digest with cosign, because a
  `needs:` edge alone would let an image publish with no SBOM bound to it. Today the SBOM is a
  per-run Actions artifact: evidence of what was scanned, not provenance attached to an artifact."
  That is exactly the gap I named, in the words I named it in.
- `.github/workflows/ci.yml:1103-1113` (new block "AND IT GUARDS ORDERING ONLY"): same statement at
  the point of maintenance, where a future publish-lane author is actually reading.
- `docs/adr/0042…md:252-259`, on Consequence 6 itself: "**The cosign-attestation half is still
  OWED**: the SBOM is a per-run Actions artifact today, and must be attached to the image digest as
  an attestation the day a vinext publish lane ships." Recorded on the obligation it belongs to,
  not only in a doc that could drift from it.

**B — the "built" markers land on both lines, each carrying the caveat. RESOLVED.**
- ADR-0042 C6: "*(Built: the `vinext-precompile-closure` CI gate, #764 — CycloneDX SBOM over the
  installed closure, coverage/emptiness guard, grype HIGH/CRITICAL, `needs:`-before every job that
  builds a vinext artifact…)*".
- ADR-0042:158, the `FROM scratch` re-open line I flagged as stale: now "Re-open only if the scan
  gate is first re-established against the pre-compile closure (built: the
  `vinext-precompile-closure` CI gate, #764 …; the cosign-attestation half of Consequence 6 is
  still owed)." Neither marker claims more than shipped — the caveat travels with the claim, which
  is the failure mode I was guarding against.

**C — the single-closure scope is stated in all three places. RESOLVED.**
- threat-model **"Scope."**: "The gate covers exactly one closure — the in-repo `examples/bun-exec`,
  which is the only vinext application that exists today. A **user** application built on the vinext
  target has no equivalent closure gate yet."
- `ci.yml:1109-1113`: same, appended to the ordering-only block.
- `tests/helpers/vinext-artifact-scan.ts:34` `CLOSURE_DIR` doc — "The closure this gate covers: the
  in-repo vinext example" — plus the matcher's own limits stated at `:44-52`.

## Did anything weaken round 1's "met" findings?

**No — criteria 2 and 3 are strictly stronger, and I re-ran the tests.** `npx vitest run` on
`tests/precompile-closure-{audit,gate-ci}.test.ts` + `tests/bun-exec-alpine-image-ci.test.ts` in the
worktree at `f4e2035`: **47/47 passed** (20 + 12 + 15).

- **Criterion 2 (needs-before publish) — durability materially widened.** The new
  `tests/helpers/vinext-artifact-scan.ts` closes two escape routes my round-1 read did not test for:
  `loadWorkflows()` scans **every** `.github/workflows/*.yml` (a publish lane is at least as likely
  to land in `release.yml`), and `BUILDS_VINEXT_ARTIFACT` now also matches
  `\b(?:bun|npm|pnpm|yarn|npx)\s+run\s+build\b` — `examples/bun-exec/package.json` defines
  `"build": "./build.sh"`, so a lane could compile the 120 MB binary while naming neither `build.sh`
  nor `docker build`. Both are tested with **synthetic not-yet-real lanes**
  (`gate-ci.test.ts:141` "catches a vinext publish lane in a NON-ci.yml workflow", `:165` "catches a
  lane that compiles via the `build` script alias") plus a **negative control** at `:189` ("a lane
  that does have the audit in its needs closure is NOT reported unguarded") — so the scan is proved
  to discriminate, not merely to fire. Second improvement: the gate is now identified by
  `runsClosureAudit()` (does a job in the `needs` closure actually run
  `scripts/precompile-closure-audit.mjs`) rather than by job **name**, so a `needs:` edge onto a
  renamed-or-gutted job no longer satisfies the test. The matcher's residual blind spots (reusable
  workflow, composite action, shell wrapper) are stated in the helper, the test header, ci.yml and
  the threat model, with the instruction to extend the pattern in the same PR — a limit disclosed
  rather than a limit hidden.
- **Criterion 3 (emptiness guard) — unchanged and extended.** All round-1 red-on-empty cases survive
  (`audit.test.ts` REJECTS zero-npm SBOM / empty closure at 100% coverage / missing anchor /
  lockfile-shape coverage; grype-with-no-`matches` throws). New: `readAllowlist` now rejects
  **unknown keys** (`ALLOWLIST_ENTRY_KEYS`), tested at `:251` "THROWS on an UNKNOWN key — a typo'd
  `expires` is a never-expiring entry", with `:273` accepting the documented optional `note`. That
  closes a real silent-neuter path on the only mechanism forcing re-justification. Floors are
  unchanged (`MIN_NPM_COMPONENTS=100`, `MIN_INSTALLED_PACKAGES=100`, `MIN_COVERAGE=0.9`); what
  changed is that the comments now say **what each number counts** (409 syft npm components vs 210
  packages by the walker vs 527 `package.json` files), replacing the round-1 text's conflated "408
  / ~500". The installed floor is correctly called out as the tighter of the two (~2× headroom) —
  honest, and it is the floor that catches an empty tree.
- **Criterion 1 — unchanged.** Same syft-over-installed-tree SBOM, same `if: always()` artifact
  upload with `if-no-files-found: error`, same assertion at `gate-ci.test.ts:84`. The blocking-gate
  audit (`:92`) and the mutation-prove registration are untouched.
- **Criterion 5b — the allowlist got *more* honest, and this is the round's most important change.**
  The round-1 justification I passed ("transitive build-time dependency; the compiled server does
  not accept attacker-supplied image buffers") was **wrong**, and the fix says so in the entry
  itself: "BE PRECISE ABOUT REACHABILITY, because an earlier draft of this entry got it wrong:
  image-size is NOT a build-only transitive dependency. It is a DIRECT, exactly-pinned dependency of
  vinext… imported SERVER-SIDE… so `resolve.noExternal` inlines it into the compiled binary and it
  runs in production." **I verified this independently** in the installed tree:
  `vinext/package.json` carries `"image-size": "2.0.2"`, and
  `vinext/dist/server/metadata-route-build-data.js:5` `import { imageSize } from "image-size"`,
  `:12` `fs.readFileSync(route.filePath)`, `:31` `imageSize(buffer)`. So the acceptance now rests on
  the correct argument — the parsed bytes are repo-owned metadata images read off the app's own
  source tree, never request bytes — with an explicit drop-not-renew condition if metadata-route
  handling ever reads image bytes from a request. Accepting a *larger* stated risk with a *correct*
  reachability argument is the right direction, and it is the opposite of silent allowlisting. The
  advisory titles were also corrected to the upstream text (JXL/HEIF and ICNS infinite loops).

## Verdict

**APPROVE.**

All three acceptance criteria of #764 are met by tested behaviour (47/47 green at `f4e2035`), the
`needs`-ordering durability is now proved against synthetic future lanes with a negative control,
and every round-1 finding is resolved in the place a maintainer would actually encounter it — the
threat model, the workflow comment, and ADR-0042 C6 itself — with the residual obligation
(cosign attestation onto a published vinext image digest) recorded as OWED rather than implied.
"Closes #764" is honest: merging resolves the issue as written, and the part of ADR-0042 C6 that
merging does *not* discharge is now written down instead of forgotten.

One thing for the lead to carry, not a blocker: the owed cosign attestation exists only as prose.
When the vinext publish lane is planned, it should arrive with a guard, since by this repo's own
standard a documented expectation degrades and its efficacy is unobservable until it has already
failed.
