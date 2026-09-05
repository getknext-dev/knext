# ISSUES_FOUND

Review of `docs/first-cluster-onramp` (8ed0c48, worktree
`/Users/banna/alpheya/pocs/knext-wt/docs-first-cluster-onramp`) as docs-guard + zero-k8s persona,
per `.claude/review-ux7-brief.md`. One blocking issue; everything else passes.

## BLOCKING — the page promises doctor-green it cannot deliver today (brief item 1)

The implementer's own transcript (impl-ux7-report.md) proves step 5's `kubectl wait` **fails on
every outside machine today**: the ghcr operator package is private (anonymous pull → 401 →
ImagePullBackOff) and the bundle's operator image is amd64-only (Apple-Silicon laptops — the
primary persona for this exact page — fail even once it goes public). The page ships that step
with **no caveat anywhere**, and actively promises the opposite:

- `first-cluster.mdx:13` (intro Callout): "When it's done, `npx kn-next doctor` reports a healthy
  cluster" — unconditional, disproven by the live run (doctor: 7 PASS, 1 FAIL, 1 WARN).
- `first-cluster.mdx:92-94` (step 5): the `kubectl wait --timeout=120s` that failed live is
  presented as a step that succeeds. A reader today sits through a 120s timeout with no warning.
- `first-cluster.mdx:110` ("All green? Head to Getting started") is conditional phrasing, and
  doctor does name the cause when it fails — partial honesty — but nothing on the page tells the
  reader that step 5 is *currently expected* to fail, or that it's the platform's gap, not theirs.

The brief's standard is explicit: "A page shipping a known-broken step without a caveat fails
docs-guard." This is that case. The zero-k8s persona hits ImagePullBackOff at the last step of a
page that opened with "No Kubernetes knowledge required" and has no way to know it isn't their
fault.

**Required fix (either):**
1. Add an in-page caveat at step 5 (and soften the intro Callout), phrased in user terms with no
   issue numbers per the house rule — e.g. a warning Callout: the operator image is not yet
   publicly pullable and has no arm64 build, so this step currently ends in `ImagePullBackOff`;
   `kn-next doctor` (step 6) will name it, and it is a known gap on our side, not your setup; or
2. Hold the page until the two release-infra gaps (package visibility, multi-arch image) are
   fixed — at which point it is publishable as-is.

Note the intro-Callout edit is needed under option 1 regardless of step-5 wording.

## Command truth — everything else (item 1, non-blocking notes)

- Steps 1–4, step 5's apply (URL resolves, bundle applies clean), and `npx kn-next doctor` were
  all run live and match the page verbatim, modulo the disclosed cluster-name substitution
  (`knext-first-cluster` + isolated KUBECONFIG) — equivalent commands, acceptable.
- Not run, both low-risk and disclosed in the report: `brew install kind kubectl` (tools
  pre-existing) and the teardown `kind delete cluster` (human-gated by hook). Neither needs an
  in-page mark.

## Persona read (item 2) — PASS, one nit

One command + one plain sentence per step throughout; jargon handled well: "CRD" avoided
("resource definitions", "the `NextApp` resource definition"), ingress introduced as "a networking
layer to route traffic", the admission webhook's TLS need explained in one clause. The honest
scoping section covers all three required truths: sleeps with the laptop (`:117-119`),
NetworkPolicy declarative-only on kind's default CNI (`:120-122`), deploys still need a registry
(`:123-125`).

- Nit (non-blocking): "your CNI supports NetworkPolicy" (`:121`) — "CNI" is the page's one
  unexplained acronym; "your cluster's network plugin (CNI)" would fix it.

## House rules (item 3) — PASS

Grep over both edited content pages: no ADR/issue/PR numbers anywhere.

## getting-started integration (item 4) — PASS

The prereq line adds the `[Your first cluster](/docs/first-cluster)` link **inside** the base
branch's F2 optional-storage Callout; the optional-bucket phrasing is intact in the diff context —
integration, not a clobber.

## meta.json, links, build (item 5) — PASS

- `meta.json`: `first-cluster` inserted directly after `getting-started`.
- All eight internal link targets exist as `.mdx` files (getting-started, install, hardening,
  gke, eks, aks, oke, openshift).
- Docs build re-run by this reviewer in the worktree: `pnpm --filter knext-docs build` → exit 0,
  `first-cluster` present in the generated output. Log:
  `<scratchpad>/docs-build-ux7.log`.

## Verdict

ISSUES_FOUND — one blocking docs-guard issue (missing caveat / false doctor-green promise on a
step proven broken today). Fix is a small, house-rule-compliant edit (or hold publication until
the two release-infra gaps close); everything else is approve-quality.

# Round 2

APPROVE

Reviewed 8846c63 (the caveat fix) on `docs/first-cluster-onramp`, same worktree. Option 1 was
taken faithfully; all four required elements verified, plus the round-1 nit fixed unprompted.

- **Step-5 warning Callout** (`first-cluster.mdx:98-109`): in user terms throughout — "The
  operator image is not yet publicly pullable, and it has no arm64 build yet", names the exact
  observable symptom (`kubectl wait` times out, pod in `ImagePullBackOff`), says plainly "That is
  our release gap, **not a mistake in your setup**", reassures that steps 1–4 are fine, and points
  at `kn-next doctor` naming the cause. No issue/PR/ADR numbers (grep clean, exit 1).
- **Intro Callout softened** (`:12-15`): the unconditional "doctor reports a healthy cluster"
  promise is gone, replaced with "tells you exactly where you stand — one step currently has a
  known gap on our side (see step 5)". Reader is warned before investing a single command.
- **Removal marker present** (`:95-97`): an MDX comment above the Callout stating both close
  conditions (public ghcr pull, multi-arch amd64+arm64 image) AND reminding the future editor to
  restore the intro's doctor-green promise — the paired edit round 1 flagged as easy to forget.
  Conditions described in plain infra terms, no issue numbers even inside the comment.
- **Docs build**: re-run by this reviewer post-fix — exit 0
  (`<scratchpad>/docs-build-ux7-r2.log`).
- **Bonus**: the round-1 CNI nit is fixed — now "your cluster's network plugin (CNI)" (`:133`).

**Persona re-read, whole page with the caveat in place — still worth starting?** Yes. The intro
sets an honest expectation without burying the lede; steps 1–4 all succeed live and teach the
reader nothing they need to unlearn; the step-5 warning converts what was a silent 120-second
timeout into an expected, explained event that is explicitly not their fault; and the closing
framing — "the rest of this page still leaves you with a cluster that's ready the moment the
image is" — gives the journey a real payoff today (a working Knative laptop cluster) rather than
a dead end. The failure now belongs to the platform in the reader's eyes, which is exactly where
it belongs. No new issues.
