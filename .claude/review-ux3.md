ISSUES_FOUND

# Adversarial review — iteration 3 (doctor no-cluster guidance), commit `df9bbd2`

Reviewed `git diff 33de434..df9bbd2` in worktree `ux3-doctor-no-cluster` (3 files: `doctor.ts`,
`doctor.test.ts`, `cli.mdx`). Ran the real CLI for all report states plus reviewer-designed
attacks; ran three mutations (exit-code-branched, exactly-once anchors, git-restored, tree
verified clean after each). Baseline: doctor suite 75/75 green, `tsc --noEmit` exit 0.

## Issue 1 — the `[::1]` branch is dead code, untested, and the impl report's claim about it is false

`LOCAL_APISERVER_RE = /\b((?:127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]):\d+)/` — the leading `\b`
requires a word char immediately before the match. `[` is a non-word char, and in kubectl's real
message it is preceded by a space (also non-word), so **no word boundary exists and the `\[::1\]`
alternative can never match**:

```
node> re.exec("The connection to the server [::1]:6443 was refused - …")  →  null
```

Proven end-to-end on the real CLI (kubectl v1.33.3, contrived kubeconfig with
`server: https://[::1]:26443`):

```
WARN  Cluster reachable  apiserver unreachable (The connection to the server [::1]:26443 was
refused - …) — all cluster checks skipped (hint: cluster connection flaked — check network/VPN and retry)
```

i.e. the original finding-1c misdirection, verbatim, for the address the code claims to handle.

Compounding evidence:
- **No test covers it.** The state-3 loop in `doctor.test.ts` iterates only
  `["127.0.0.1:26443", "localhost:8080", "0.0.0.0:6443"]`; `grep '::1'` over the test file: zero hits.
- **Mutation M3** (delete `|\[::1\]` from the alternation): suite stays **GREEN**. The alternative is
  decoration — exactly the guard-both-halves defect class this repo documents.
- The impl report ("connection refused on `127.0.0.1` / `localhost` / `0.0.0.0` / `[::1]`") and the
  `doctor.ts` header comment both claim `[::1]` as delivered; the report's own mutation list mutated
  `0.0.0.0` but never `[::1]` — the one alternative whose mutation would have exposed this.
- The user docs (`cli.mdx`) list only the three working addresses, so the shipped docs are honest;
  the false claim lives in code comment + report. The brief named `[::1]` explicitly as an attack
  boundary; it does not survive it.

Failure direction is the benign one (a stale IPv6-loopback local cluster keeps the old flake hint —
no real cluster owner is told "no cluster"), but a claimed, commented, report-listed behavior that
is provably absent and mutation-invisible cannot pass this gate. Fix is small: drop/replace the
`\b` (e.g. anchor on `(?:^|[\s/])`) **and add the `[::1]` fixture to the state-3 loop** so the
regex change is load-bearing.

## Issue 2 — the default `inspectKubeconfig` wiring is invisible to the suite (guard-dodge M2 GREEN)

Mutation M2 replaced the call-site fallback
`(deps.inspectKubeconfig ?? inspectKubeconfig)()` with
`(deps.inspectKubeconfig ?? (() => ({ kind: "has-current-context" })))()` — i.e. the real CLI would
**never** diagnose absent/no-context again — and the doctor suite stayed **GREEN** (75/75).
Every `runDoctor` test injects `inspectKubeconfig`; the 7 unit tests call the exported function
directly; nothing asserts that `runDoctor` consults the real inspector by default. `grep` confirms
no other test file references `inspectKubeconfig`. The feature's two halves (classifier correct;
classifier actually wired in production) are each tested alone — the join is not. One test that
runs `runDoctor` without injection under a stubbed `$KUBECONFIG`/`$HOME` (the unit tests already
show the `vi.stubEnv` pattern) closes it.

## Wording nit (fix alongside, not blocking on its own)

For a **real remote cluster reached through a local tunnel** (`ssh -L`, `tsh proxy kube`, OCI
bastion port-forward — kubeconfigs that legitimately point at `127.0.0.1:<port>`), a downed tunnel
now yields "an address on THIS machine, so this **is** a leftover local cluster (kind/minikube/
OrbStack/k3d) … **not a network problem**" — definitively wrong for that population (the remedy is
network-ish: restart the tunnel). The docs hedge correctly ("**usually** a leftover from a local
cluster"); the CLI message should hedge the same way instead of asserting certainty.

## Verified good (attacks that failed)

- **Report Before/After**: all four states reproduced on the real CLI **verbatim** (modulo tmp
  paths); exit 0 and all-SKIP degrade contract intact in every state.
- **Mutation M1** (brief-required: `diagnoseNoCluster` returns `undefined` always — everything a
  flake again): suite **RED**. The classification tests are real.
- **Remote refused stays a flake** (192.168.1.1:6444, genuinely refused on this network): flake hint
  preserved verbatim; DNS-failing remote ("no such host", resolver at `127.0.0.53:53`) cannot match
  — the regex requires `127.0.0.1` exactly and `/refused/i`.
- **Dead local proxy in front of a remote cluster** (`proxy-url: http://127.0.0.1:1`, and the
  `HTTPS_PROXY` env variant): kubectl v1.33 masks proxyconnect — stderr names only the remote
  server, so the code conservatively keeps the flake hint. (Residual: older kubectl emitting raw
  `proxyconnect tcp: dial tcp 127.0.0.1:…: connection refused` would false-positive; unprovable on
  this machine, noting only.)
- **KUBECONFIG → directory**: `readFileSync` EISDIR → caught → `has-current-context` → legacy path
  (real CLI verified). **Dangling current-context** (`context "gone" does not exist`): inspector says
  has-context, stderr has no refused/local → legacy path, no false claim (real CLI verified).
  **Corrupt YAML**: conservative `has-current-context` (unit-tested). `127.0.0.2`/`127.0.0.10`
  loopbacks: no match → flake (conservative direction, acceptable).
- **Auth precedence (#230)**: tested with a contradictory inspector (absent + exec-credential
  stderr) — auth hint wins, no "no cluster" claim.
- **Iteration-2 conventions**: diff adds no `throw new Error(` and touches no test/allowlist —
  the inverted scan guard (`cli-dispatch-contract.test.ts`, 68 tests) passes against the new code
  unmodified. No new fatal/exit paths, so the both-streams rule is untouched.
- **Docs URL**: `DOCS_URL = "https://knext.dev"` (`help.ts:38`) + `/docs/getting-started` —
  `apps/docs/content/docs/getting-started.mdx` exists, is listed in `meta.json`, and the
  `/docs/getting-started` path is the established cross-reference form (home page, `install.mdx`,
  cloud guides, and the new `cli.mdx` link). Not invented.
- **`yaml` is a runtime `dependencies` entry** of `@getknext/core` (not dev-only), so the new
  shipped-code import is safe for the published bin.
- Typecheck exit 0; doctor suite 75/75; worktree left clean (`git status` porcelain empty).

## Verdict

`ISSUES_FOUND` — Issue 1 (dead, untested, falsely-claimed `[::1]` handling) and Issue 2 (default
inspector wiring invisible to the suite) each need another round; the tunnel wording nit should
ride along.

# Round 2 — commit `d622d79` (diff `df9bbd2..d622d79`)

APPROVE

All three round-1 findings are fixed and each fix is now mutation-proved load-bearing.

1. **`[::1]` anchor fix — verified on the real CLI.** The regex is re-anchored on
   `(?:^|[\s/])` (a word boundary can never precede `[`), and the same `[::1]:26443`
   kubeconfig that got the flake hint in round 1 now yields:
   `connection refused at [::1]:26443 — an address on THIS machine, usually a leftover local
   cluster (kind/minikube/OrbStack/k3d) that is not running` + the local-cluster hint, exit 0.
   The `[::1]:26443` fixture was added to the state-3 test loop, and **re-running my M3 mutation
   (delete `|\[::1\]` from the alternation) now goes RED** — the branch is no longer decoration.

2. **Default-wiring test — verified.** New no-injection test runs `runDoctor` with only a
   stubbed `$KUBECONFIG` pointing at a nonexistent path and asserts the no-cluster guidance.
   **Re-running my M2 stub mutation (replace the `?? inspectKubeconfig` fallback with a
   has-current-context stub) now goes RED.**

3. **Wording nit — fixed.** Detail hedges ("**usually** a leftover local cluster", the "not a
   network problem" assertion is gone) and the hint now covers the tunnel population explicitly
   ("restart that local cluster **(or the tunnel that used to forward this port)**"). Matches the
   docs' hedged phrasing.

4. **No regressions.** Real CLI re-run across all states: `127.0.0.1:26443` and `0.0.0.0:6443`
   still classify with the new wording; states 1–2 (absent / no-current-context) unchanged
   verbatim; the genuinely-refused remote (`192.168.1.1:6444`) keeps
   `cluster connection flaked — check network/VPN and retry` verbatim; exit 0 + all-SKIP degrade
   everywhere. (The live `localhost:8080` run hit this machine's dev-server squatter, which
   *answers* rather than refuses — stderr has no "refused", the classifier correctly declines,
   and the refused shape stays covered by the state-3 unit fixture.) New-anchor false-positive
   spot-checks all pass: `5127.0.0.1:80`, `svc.localhost:8443`, resolver `127.0.0.53:53`, and
   `127.0.0.10:6443` all decline; `^`-anchored and `https://`-prefixed local addresses match.
   M1 (disable classification) still RED. Baseline 77/77 green, `tsc --noEmit` exit 0, worktree
   left clean.

Non-blocking observation for the lead: `cli.mdx`'s illustrative address list
(`127.0.0.1`, `localhost`, `0.0.0.0`) was not extended with `[::1]` — harmless (the list is
illustrative and hedged), but a one-word docs touch-up could ride along in a later pass.
