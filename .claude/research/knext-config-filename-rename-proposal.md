# Proposal: `kn-next.config.ts` → `knext.config.ts` (follow-up to #1369)

Not implemented in #1369 — explicitly out of scope per the task ("Do NOT rename
... the `kn-next.config.ts` filename ... If the config filename should also
become `knext.config.ts`, propose it with jev scores. It would need to read
both names, which is its own decision."). This file is that proposal.

## Recommendation: do it, but as its own follow-up issue, not bundled into #1369

jev scores (`~/.claude/skills/jev`, doctor healthy):
- "Should the config filename also be renamed in the SAME PR as the bin
  rename?" → **0.11 yes** (i.e. jev leans strongly against bundling it).
- "Is it safe to defer the config-filename rename to a follow-up issue?" →
  **0.80 yes**.

Read as a gut-check, not an oracle (per this repo's jev usage note): both
scores point the same direction — sequence it separately.

## Why separate

1. **Scope discipline.** #1369's diff is already large (CLI text across
   ~85 files, two new dist entries, a runtime-proxy mechanism for the bin
   split). Bundling a second breaking-ish surface change (a config file
   rename, even with dual-read) makes the PR harder to review and revert
   independently if either half needs rework.
2. **Different risk shape.** The bin rename is low-risk — `kn-next` keeps
   working byte-for-byte, just with a stderr notice. A config-filename dual-
   read is higher-risk: `loadConfig()` (`shared.ts`) would need to decide
   *which* file wins when both exist, warn on the deprecated one, and every
   template/doc/error message that names `kn-next.config.ts` (scaffold
   templates, `create.ts`'s guidance, `doctor.ts`, `status.ts`, `db-bind.ts`,
   the CRD-schema preflight messages, the docs site) touches the SAME files
   #1369 just edited for the bin name — a second pass over the identical
   surface is more error-prone done in the same round than done fresh.
3. **No forcing function.** Unlike the bin (where the npm package name
   `knext` was unavailable and the CLI command itself is what users type
   constantly), the config filename is read once per command and only
   surfaces in an error message or a `require`/`import` path — the UX cost of
   leaving it as `kn-next.config.ts` for one more release is low.

## What the follow-up should do, sketched (not committed)

- `knext.config.ts` wins if both exist; `kn-next.config.ts` still loads with
  a deprecation warning (same one-line-to-stderr shape as the bin notice).
- `CONFIG_FILE` in `shared.ts` becomes a resolution function, not a constant.
- `knext create` scaffolds `knext.config.ts` going forward; existing apps are
  not migrated automatically.
- Every place that HARDCODES the filename in a message (grep `kn-next.config`
  across `src/cli/` — ~20 sites after #1369) needs the same dual-name
  treatment the bin got in #1369's `printDeprecatedKnNextNoticeIfNeeded`.
