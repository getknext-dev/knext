APPROVE

# Adversarial review — #798 rotate-cred gateway host + hold re-dial

Worktree `/Users/banna/alpheya/pocs/knext-wt/rel1`, branch `fix/rotate-cred-gateway-host`,
commit `707f547` vs `origin/main`. 11 files, +568/−39.

Attacked on all six vectors in the brief. Every attack failed to break it. All mutation proofs
were run **after** the commit, restored with `git checkout HEAD -- <file>`, and the tree verified
residue-free (`git diff --stat HEAD` empty) at the end.

## Mutation harness — proved able to see BOTH colours first

`scratchpad/mut.sh`: asserts the anchor occurs **exactly once** (aborts otherwise), asserts the
file actually changed on disk, branches on **exit code only** (never output text — vitest ANSI has
certified decoration here before), restores, then fails loud on residue. Control mutation
(comment-only edit to `provision-app.sh`) reported **GREEN**, so the harness is not stuck-red.

| # | mutation | target guard | result |
|---|---|---|---|
| M1 | `mint_credential` reverted to the inlined `@pggw-apps.$NS…` | `test_provision-app.sh` | **RED** (`create: …was NOT honoured`) |
| M2 | `cmd_rotate_cred` reverted to the inlined host | `test_provision-app.sh` | **RED** (`rotate: …was NOT honoured`) |
| M3 | `gen-secrets.sh` `DBHOST` reverted to the hardcoded literal | `test_gen-secrets.sh` | **RED** |
| M4a | dead hold returns early, never re-dials | `warmhold_rotation_test.go` | **RED** (`dialed 1 times, want 2`) |
| M4b | DSN memoised from the first dial (the exact claimed defect) | `warmhold_rotation_test.go` | **RED** (`redial used …oldpw`) |
| M5 | `:-` alternative dropped from `GATEWAY_HOST_IN_POSITION` | `rooted-minted-hosts.test.ts` | **RED** (3 failed) |
| M6 | `cmd_rotate_cred` inlined (= M2) | `deploy/_validate.sh` | **RED**, and reported via the **aggregator** (`1 FAILURE(S)`), not an early exit |
| C | comment text only | `test_provision-app.sh` | **GREEN** (control) |

**(1) No half-fix.** M1 and M2 red **independently** — reverting either writer alone is caught.
`gen-secrets.sh` (M3) is the third writer and is covered separately. Repo-wide hunt confirms these
are the only writers of the Secret: `grep` for `create secret generic "app-db-` returns exactly
`provision-app.sh:195` (mint) and `:641` (rotate). Every other `@pggw-apps` in `deploy/` is a
transient client DSN in a `_verify-*.sh` drill — nothing that overwrites a Secret.

**(2) Precedence matches the operator byte-for-byte.** Operator: `env()` in
`gateway/cmd/appdb-operator/main.go:36-41` returns `def` iff `os.Getenv(key) == ""`. Shell:
`${APPDB_GATEWAY_HOST:-…}` (colon-dash). Not taken on faith — compiled the operator's `env()` and
ran it head-to-head against the shell expansion over `"   "`, `"\t"`, a custom FQDN, `a@b`,
`host/x`, and unset: **identical output on every input**.

**(3) Rooted discipline survives.** Default is rooted in both scripts and is guarded twice (the
`:-…\.}"` contract in `_validate.sh`, and the TS predicate — whose new `:-` alternative is itself
mutation-proved by M5, which matters because moving the literal into a default would otherwise have
been a way out of the whole guard). Drove real values through **both writers** with the env set
before the script loads: `gw.custom.zone.` → verbatim, `gw.custom.zone` → verbatim (**not**
auto-rooted), `gw.custom.zone..` → verbatim (**not** de-duplicated), bare `pggw-apps` → verbatim.
No re-rooting, no double-rooting, no re-qualification — exactly the operator's contract.

**(4) Empty and whitespace.** Empty → the rooted default in both scripts, asserted by committed
cases (`test_provision-app.sh` (d), `test_gen-secrets.sh` (d)); this is the whole reason `:-` and
not `-` was used, and it matches the operator. Whitespace-only → passed through **verbatim by the
operator and by both scripts alike**. That is not fail-closed, but it is not a silent fallback to a
wrong host either: it is the admin's literal value, and the two resolutions **do not diverge**,
which is the bug class #798 is about. Noted below rather than raised.

**(5) Hold re-dial across a rotation.** The three new Go tests exercise a real rotation under a held
session (`rotatingDSN` returns a different DSN after the rotation, as `K8sCluster.DatabaseURL`'s
per-call Secret GET does) and cover all three states: healthy hold untouched (and the Secret not
even re-read), dead hold re-dialled on the **rotated** DSN, and a re-dial the old verifier rejects
surfacing `28P01` and **dropping** the app from `Held()` so `appdb_warm_hold_active` falls. M4a and
M4b both red — the tests are load-bearing for both halves of the claim, not just "does it dial".

**(6) `_validate.sh`.** Ran it against the live plane: **`deploy validation: all checks passed`,
rc=0**, including the rewritten contract 24. M6 proves the new `@pggw` inline-host contract is not
decoration and that the aggregating `fail()` reports it at the end rather than dying early.

## Other gates run

`go test ./...` (gateway) rc=0 · `gofmt -l` empty + `go vet ./...` rc=0 · `test_provision-app.sh`
35 cases · `test_gen-secrets.sh` 5 cases · `test_skctl.py` 19 tests · vitest
`rooted-minted-hosts` + `rooted-cluster-hosts-repo-wide` 19 passed · `biome check` on the changed TS
clean at `--diagnostic-level=error` (the `biome-ignore-start/end` block is correctly scoped to the
shell-`${…}` fixtures). `package.json` wires `test_gen-secrets.sh` into the `test` script, which
`.github/workflows/scale-zero-pg.yml` runs via `turbo run … --filter=scale-zero-pg`, so the new
suite actually gates. `sh "$GEN"` in the new test matches `gen-secrets.sh`'s `#!/bin/sh` shebang, so
it will not diverge under dash on the CI runner.

## Observations — none blocking, none require another round

1. **`_validate.sh:623` `[ $(grep -c '@\$GW_HOST' …) -ge 2 ]` is the weakest of the four
   contracts.** There are **3** `@$GW_HOST` sites (both writers plus the `cmd_create` summary
   heredoc), so reverting exactly one writer to a hardcoded host that does **not** start with
   `pggw` would keep the count at 2 and slip past the `grep '@pggw'` scan too. The behavioural test
   (M1/M2) catches that case, so the hole is covered — but the count reads stronger than it is. If
   it is ever tightened, `-ge 3` with a comment naming the third site is the cheap version.
2. **The default diverges from the operator's in a non-default namespace.** The scripts' default
   follows `$NS` (`pggw-apps.${NS}.…`, asserted by test case (e)) while the operator's
   `appdb.DefaultGatewayHost` (`ports.go:188`) is a fixed `…scale-zero-pg.…` const and
   `83-appdb-operator.yaml:142` hardcodes the same namespace in the env value. On `NS≠scale-zero-pg`
   the script is the *more* correct of the two, and the manifest must be edited for such a plane
   anyway — but the "byte-for-byte" framing in the code comment holds for the *precedence*, not for
   the default's namespace. Pre-existing (the old inlined literal used `$NS` too); not introduced
   here.
3. **Whitespace-only override** is accepted verbatim by both the operator and the scripts (see (4)).
   Parity is preserved; neither fails closed. Fine as-is, worth knowing.
4. **No live-cluster run of the new drill §4.** The implementer's report declares this openly. The
   drill needs a warm app and cluster work is a queue of one, so it is correctly deferred to
   whoever holds the plane — flagging it because the standing OKE stage is lead-owned, not because
   the code is unverified (the unit halves are).
5. Cosmetic: `docs/appdatabase-api.md` leaves one over-long unwrapped line in the edited
   "Scope: newly minted apps only" paragraph.

## Verdict

**APPROVE.** The bug class it targets is real and it is closed on all three writers, each proved
independently. The guards it adds are behavioural (the value that reaches the Secret) rather than
textual, and every one of them reds when its subject is removed. The docs state the residual
no-bounce hazard rather than hiding it.
