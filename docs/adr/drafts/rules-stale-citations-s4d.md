# Draft for the maintainer: three stale citations in the governance files (sprint-4 S4-D)

`.claude/rules/` and `CLAUDE.md` are maintainer-owned, so this is a proposed diff, not an applied
one. All three were verified against the tree on `main` by the sprint-3 close gates and re-verified
here. Each is a citation that has gone stale — the kind `security.md` itself warns "degrades, and its
efficacy is unobservable until it has already failed."

---

## 1. `architecture.md` §4 — mandates a guard file that was DELETED

**Current text (architecture.md:50)** requires instrumentation→app seams to be covered by
`apps/file-manager/standalone-seam-alive.test.ts` (#344).

**Stale because:** that file does not exist on `main` (`ls` → No such file), and the seam-alive gates
were **retired in #885** (the stability sprint) — see `.github/workflows/ci.yml:491`
("seam-alive gates: RETIRED (#885, stability sprint)"), `:874`, `:950`. A hard rule pointing at a
deleted guard tells the next reader to rely on coverage that no longer exists.

**Proposed:** replace the `standalone-seam-alive.test.ts` mandate with whatever now guards the #352
duplicated-module-state class (if anything), or state plainly that the guard was retired with #885 and
name its replacement (the build-artifact guard the ci.yml note references), or drop the mandate if the
class is no longer reachable under ADR-0048 (vinext, no webpack layers — the #352 mechanism was a
webpack-layer duplication that the standalone/webpack path had and the vinext path does not).

## 2. `security.md` (§ digest-pinning, line 43) — cites a moved file + a resolved placeholder

**Current text (security.md:43):** "fix the remaining placeholder (`config/manager/manager.yaml` →
`controller:latest`)."

**Stale because:** `config/manager/manager.yaml` does not exist on `main`, and CLAUDE.md §4 already
records this as **RESOLVED 2026-08-16** — the manager manifest carries `image: controller` with no
tag, and the release bundle is regenerated with the real pushed digest. `security.md` is carrying the
pre-resolution version of a line CLAUDE.md has already retired (CLAUDE.md §4 flags this exact drift:
"`.claude/rules/security.md` still carries the stale version of this line — flagged for the
maintainer").

**Proposed:** delete the parenthetical, or replace it with the resolved statement from CLAUDE.md §4.

## 3. `CLAUDE.md` §7 (line ~120) — the byte cap is CLOSED, not "still open"

**Current text (CLAUDE.md:120):** "**Still open and deliberately so:** the in-process byte cap
(ADR-0044 Option C) is deferred on a dated exception with a hard expiry at Tier-A exit or v1.0."

**Stale because:** the byte cap **shipped in #915 this sprint** (srvx `maxRequestBodySize`, default
8 MiB app / 64 KiB metrics, env `KNEXT_MAX_REQUEST_BYTES`, chunked-oversize → 413 proven on Bun 1.4),
enforced on the binary and mutation-proved (`scripts/mutation-prove-bytecap.mjs`). The dated exception
it describes was discharged, not renewed.

**Proposed:** move the byte cap from "still open" to the delivered list, citing #915 + ADR-0044
Amendment 4; keep only what is genuinely still deferred (rate limiting / payload caps as documented
recipes, which the same paragraph already correctly scopes).

---

*Companion drafts already staged for the maintainer: `docs/adr/drafts/rules-amendment-architecture-s4.md`
(the §4 vinext-default amendment, C1) and `docs/adr/drafts/0007-amendment-compat-window-anchor.md`
(ADR-0007, #944). Applying all of these is one maintainer pass.*
