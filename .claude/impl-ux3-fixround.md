# Fix round — iteration 3, review-ux3 findings (read .claude/review-ux3.md in full first)

Two issues + one wording nit, all in your worktree/branch (commit --no-gpg-sign, no push yet):

1. **`[::1]` is dead code.** `LOCAL_APISERVER_RE`'s leading `\b` cannot match before `[` — the
   reviewer proved the real CLI still emits the old flake misdirection for
   `server: https://[::1]:26443`. Fix the anchor (e.g. `(?:^|[\s/])` — reviewer's suggestion; make
   sure `127.0.0.1` etc. still match after the change) AND add `[::1]:26443` to the state-3 test
   loop so the fixture is load-bearing. Then run the reviewer's mutation M3 (delete `|\[::1\]`) and
   confirm it reds now.
2. **The default-wiring join is untested.** Every runDoctor test injects `inspectKubeconfig`; the
   reviewer's M2 (stub the call-site fallback) stayed green. Add one test that runs `runDoctor`
   WITHOUT injection under `vi.stubEnv`'d `KUBECONFIG`/`HOME` pointing at a scratch no-cluster
   state, asserting the no-cluster guidance appears. Re-run M2, confirm red.
3. The wording nit in the review's "Wording nit" section — apply it.

Also correct your report's claims to match reality (the repo rule: re-read claims against the
tree). Suite + tsc + biome green. Update .claude/impl-ux3-report.md with the two mutation re-runs.
