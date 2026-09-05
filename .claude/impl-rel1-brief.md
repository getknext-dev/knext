# Reliability iteration 1 — #798: rotate-cred clobbers custom-zone gateway host; hold re-dial untested

Repo /Users/banna/alpheya/pocs/knext. Branch `fix/rotate-cred-gateway-host` from origin/main,
isolated worktree under /Users/banna/alpheya/pocs/knext-wt/. Commit --no-gpg-sign, push when
green, no PR. (If your session hits a Fable 5 usage limit, run /model opus and continue.)

Read #798 fully (gh issue view 798). Two halves, both reliability-class:

1. **Scripts ignore APPDB_GATEWAY_HOST.** The operator honours the env override verbatim (both
   halves tested), but provision-app.sh (BOTH writers, including the rotate-cred path) and
   gen-secrets.sh hardcode the rooted default `pggw-apps.$NS.svc.cluster.local.` — so on a
   cluster with a custom gateway service name, a credential rotation silently rewrites a working
   DSN to an unresolvable host. That is a data-plane outage triggered by a routine operation.
   Fix: the scripts honour the same override with the same precedence as the operator (read the
   operator's resolution to match it EXACTLY — divergence between the two is the bug class this
   repo keeps hitting), keep the rooted-FQDN discipline (trailing dot) for the default, and cover
   BOTH writers (the repo's assert-both-halves rule — a fix to one writer is the classic half-fix).
2. **Hold re-dial across rotation is untested.** The hold-shape keepwarm holds a long-lived
   session; nothing proves it re-dials correctly when credentials rotate underneath it. Add the
   missing coverage at the level you can honestly test in-repo (script-level/unit with a fake
   rotation, or an integration test if the harness supports it) — and if a real gap surfaces,
   fix it; if the behaviour is already correct, the test still lands as the missing guard.

TDD both; mutation-prove every new guard (an override that stops being honoured must red; a
one-writer-only fix must red); scale-zero-pg's _validate.sh contracts must stay green (it now
aggregates — run it). Report → worktree .claude/impl-rel1-report.md.
