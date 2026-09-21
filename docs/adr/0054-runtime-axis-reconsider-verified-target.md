# ADR-0054: Reconsider the vinext-only target — adopt a verified 778/0 runtime axis for v1.0

- **Status:** **Proposed (2026-09-22).** Awaiting founder decision + the sprint-close design-gate
  review. This is a planning artifact opening the Runtime-Axis Resolution sprint, **not** a merge
  gate — per the 2026-09-22 workflow amendment the architect/system-designer gates convene at sprint
  close, and ADR-0048 was itself a founder decision, so its reconsideration is founder territory.
- **Reconsiders:** ADR-0048 (vinext + Bun 1.4 single-executable as the ONLY target, Accepted
  2026-08-27). Does **not** yet supersede it — records that both premises ADR-0048 rested on have
  since been measured away, and recommends a decision.
- **Relates to:** ADR-0036 (optional vinext build target), ADR-0042 (vinext default runtime),
  ADR-0048 Amendment 4/5 (the cold-start-premise correction, in-flight PR #1036), the #605
  runtime-axis go/no-go.
- **Amends a hard rule (if Accepted).** `.claude/rules/architecture.md §4` and `CLAUDE.md §3` both
  encode ADR-0048's vinext-only stance. Accepting this ADR requires the maintainer to reconcile
  those rules. `.claude/rules/` is not an agent's file to edit — recorded here, not left implicit.

## Context

ADR-0048 (founder, 2026-08-27) made the compiled **vinext + Bun 1.4 single-executable** the *only*
build/runtime target, retiring the official-adapter node-standalone path. It rested on two measured
premises:

1. **A decisive cold-start win** — its table showed 61 ms cold median vs node's 884 ms.
2. **Build-weight** — vinext's single-executable was expected to be the lighter artifact.

Both have since been measured away, and a third axis has been verified that ADR-0048 never weighed:

- **Cold-start is TIED on a real cluster.** OKE, N=7 paired cold cycles, two operator-reconciled
  `NextApp` CRs (`.claude/oke-coldstart-bench.md`): node-standalone **3610 ms** (3143–3948) vs
  vinext single-exec **3401 ms** (3226–3761) median — ~6%, ranges fully overlap. Cold-start is
  Knative activate→schedule→container-create bound (~3.4 s), which swamps runtime boot. ADR-0048's
  **61 ms was a local warm-binary process-boot micro-bench** (`examples/bun-exec`, n=10, binary
  already page-cached) that excluded the cluster path — ADR-0048's own **Amendment 5** concedes
  this. A truly-cold local spawn is ~1.8 s. So cold-start **does not differentiate the axes**.
- **Build-weight favours node, not vinext.** #605 V2 measured the vinext artifact **31% larger** at
  capability parity (`@vercel/og` alone ≈ 39% of it) — the premise is inverted. *(Re-verified this
  sprint: sprint task T6.)*
- **Two verified 778/0 axes exist.** node-standalone is 778/0 (the official-suite credential — the
  verified-adapter north star) but ADR-0048 made it un-selectable. **bun-standalone** (`next build`,
  boot on Bun 1.4.0) is **778/0, corroborated this session** across two green runs
  (`35652804130`, `35659440363`; PR #1139). Meanwhile the shipped vinext artifact is **~92% @ Next
  16.2 / ~87% @ 16.3.5**, with an 84-file 16.3.x residue (multi-cause: build-layout ENOENT,
  asset-path 404s, React-internals skew, vite-build failures), an ESM-only app contract (ADR-0051,
  excludes CommonJS apps), and a high-complexity build path (vite→nitro→compile).

vinext's **only** surviving measured advantage is **image size** (42.9 vs 66.6 MiB).

## Decision (recommended, for founder + gate ratification)

**Stop making the compiled vinext single-executable the *only* target.** Adopt a verified **778/0**
axis as the v1.0 selectable/default runtime, restoring the verified-adapter credential path.

**Recommend bun-standalone** as that axis: `next build` → boot on Bun 1.4.0. It delivers full
node-parity compat (778/0), the same cold-start as everything else, `next build` simplicity (no
vite→nitro→compile path, no ESM-only contract), and is Bun-native — which is what the "fork vinext
to run on Bun" idea was reaching for, at full compat and zero fork.

**Keep vinext as an opt-in, compat-gated target** for its one real edge (image size) — not the
default, not the only option. Demote its weekly lane from shipped-artifact gate to experimental.

## Options considered

| Option | Compat | Cluster cold-start | Build | Image | Verdict |
|---|---|---|---|---|---|
| **node-standalone** | **778/0** (credential) | ~3.6 s | `next build`, simple | 66.6 MiB | Strong; retired by ADR-0048. Re-selectable is the fallback. |
| **bun-standalone** | **778/0**, corroborated (Bun 1.4.0) | ~3.4 s (tied) | `next build` on Bun, simple | ~= node | **RECOMMENDED** — verified + Bun-native + simple. |
| **vinext single-exec** (ADR-0048 status quo) | ~87% @16.3.5, 84-file residue | 3401 ms (tied) | vite→nitro→compile, complex, ESM-only | **42.9 MiB** | Both premises collapsed; keep opt-in for image size only. |
| **Fork vinext to be Bun-native** | unknown | — | core rewrite; Bun's bundler can't do RSC graph separation | — | **Rejected** — bun-standalone already delivers Bun-native at 778/0 with no fork. |

## Consequences

- **Restores the north star.** A 778/0 axis becomes user-selectable again, so verified-adapter
  status (official-suite pass, listed in the Next.js docs) is reachable for the shipped artifact —
  which vinext-only forfeited for a ~87% target.
- **Public surface changes.** If node/bun-standalone becomes selectable, the CLI `build` target
  surface and `kn-next.config.ts` schema change (a public-API + CRD-adjacent consequence) — sprint
  task, needs the config/CLI trigger handled.
- **vinext demoted to opt-in.** Its compat lane becomes experimental; its 16.3.x residue support
  effort is no longer on the v1.0 critical path.
- **bun-standalone needs a scheduled lane.** Its 778/0 is *verified-once* (two dispatch runs on
  1.4.0), not *credentialed* — a scheduled Bun-1.4.0 lane moves it verified→credentialed (sprint
  task T3).
- **Rules must be reconciled** (maintainer): `architecture.md §4` + `CLAUDE.md §3`.
- **Honest about the trade this reverses:** ADR-0048 chose the stronger form (only, not default) on
  a cold-start premise that a real cluster has since tied. This ADR does not paper over that — it
  is the "discovered fact that invalidated the prior plan" escalation trigger, realized.

## Action items

1. Founder + sprint-close gates ratify or revise this recommendation. *(blocks the rest)*
2. Maintainer reconciles `architecture.md §4` + `CLAUDE.md §3` to the chosen axis. *(sprint T2)*
3. Compat-lane consolidation: the chosen axis gets a scheduled red-on-fail lane; matrix rows reflect
   real axis roles. *(sprint T3)*
4. If vinext is demoted, re-scope the replacement compat bar (PR #1137) to the chosen axis.
   *(sprint T4)*
5. Re-measure build-weight locally to firm the inherited "31% larger" claim. *(sprint T6,
   agent-doable)*
