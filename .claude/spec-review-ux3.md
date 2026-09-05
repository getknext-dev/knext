APPROVE

# Spec review — iteration 3, finding 1c (doctor no-cluster guidance), commit df9bbd2

Judged empirically as the binding persona: I ran the real CLI (`bun packages/kn-next/src/cli/deploy.ts doctor`)
in the worktree with contrived kubeconfigs (kubectl v1.33.3) and read the words the persona would read.

## Empirical runs (all exit 0, all cluster checks SKIP — degrade contract intact)

| State | What doctor said | Verdict |
|---|---|---|
| `KUBECONFIG=/nonexistent/kubeconfig` | `no kubeconfig found (searched: …) — you don't have a Kubernetes cluster connected yet` + hint `kn-next deploys into one; follow https://knext.dev/docs/getting-started to get set up, then re-run doctor` | ✅ plain, actionable |
| empty config (no `current-context`) | `kubeconfig <path> sets no current-context — you don't have a Kubernetes cluster connected yet` + same hint | ✅ |
| refused dial at `127.0.0.1:26443` (the ledger's verbatim case) | `connection refused at 127.0.0.1:26443 — an address on THIS machine, so this is a leftover local cluster (kind/minikube/OrbStack/k3d) that is not running, not a network problem` + hint `start it again, or follow https://knext.dev/docs/getting-started to connect a different cluster` | ✅ the measured misdirection ("check VPN and retry") is gone |
| non-local address failure (`192.168.1.6:26444`, i/o timeout) | legacy `cluster connection flaked — check network/VPN and retry`, verbatim | ✅ the user who DOES have a cluster having a bad day keeps the right hint |

Bonus finding from my own first (broken) fixture: an ambiguous stderr (`error: EOF`, no address, no
"refused") with a set current-context falls back to the legacy generic message — the conservative
"never misdiagnose a real cluster as absent" design holds in practice, not just in the comment.

## The brief's questions

- **Plain English, says "no cluster connected yet"?** Yes — the exact clause *"you don't have a
  Kubernetes cluster connected yet"* is in both the detail and the hint for the absent and
  no-context states. The technical prefix (`no kubeconfig found (searched: …)`) is an evidence
  trail, not a prerequisite: the persona can act on the hint without knowing what kubeconfig is.
- **Actionable for someone who never heard of kubeconfig?** Yes — the next step is a URL, then
  "re-run doctor". No k8s verbs required of the user.
- **Docs pointer real?** Yes, verified — `DOCS_URL = "https://knext.dev"` (`help.ts:38`) and
  `apps/docs/content/docs/getting-started.mdx` exists, so `https://knext.dev/docs/getting-started`
  is a real slug, not invented. The `cli.mdx` addition links relative `/docs/getting-started` — same
  real page.
- **REMOTE flake preserved?** Yes, empirically (row 4) — and precedence for #230 auth/RBAC
  classifications is guarded in code (`cls === "auth" || "forbidden"` skips the no-cluster path)
  and by a test the implementer mutation-proved.
- **Scope honesty?** The diff is exactly 3 files (doctor.ts +131, doctor.test.ts +262, cli.mdx +8)
  — all within 1c; no CLI-surface/flag/schema change; kubectl verb surface unchanged (pure local
  file reads, `existsSync`/`readFileSync` only). Every report claim I checked is in the diff or
  reproduced: `doctor.test.ts` runs **75/75 green** in the worktree (verified). The report's
  base-branch rename note and the localhost-squatter false-green hazard are disclosed, not hidden —
  the latter is correctly scoped out (it pre-exists 1c: the gate trusts `version.ok` before any
  inspection).

## Minor observations (non-blocking)

1. State-3 wording names `kind/minikube/OrbStack/k3d` — mild jargon, but it is the population that
   *causes* that state (tools that write kubeconfig entries the persona never knowingly created),
   and the hint stays plain. Acceptable.
2. State-3 does not literally say "you don't have a cluster connected yet" — deliberately, since
   that user *has* a (stopped) local cluster configured. Closer to the truth than the ledger's
   literal fix wording; satisfies its intent (no misdirection + getting-started pointer).

Finding 1c is closed for the binding persona.
