APPROVE

# Spec review — feat/optional-storage vs the design gate (architect-design-storage.md) + row 3b

Reviewed empirically as the zero-k8s persona from a scratch dir, against the diff vs merge-base
`1074119` with origin/main. All six PROCEED conditions are met by real, tested behavior; the ADR
matches the tree; no scope drift.

## Empirical persona run (scratch dir, worktree entry via bun)

- **`create demo-app`** scaffolds 13 files. The generated `kn-next.config.ts` has **`storage`
  fully commented out** with a plain-language growth path above it ("serves its own static files
  from the container image, just like `next start` … Add this block later when you want faster
  static delivery from a bucket/CDN, and old builds' files kept through a deploy", with the
  `multi-cloud#starting-without-object-storage` docs link). One remaining prerequisite: the
  registry placeholder. **Condition 6 ✔** (also pinned by `optional-storage.test.ts:273/285/295`,
  mutation M7 killed).
- **Parting line** is the persona's real next steps in order: `cd … && npm install`, `npm run dev`,
  then `kn-next doctor` → `kn-next deploy`, with `test:seam` last and in plain words. ✔ (pinned by
  the row-3a test, mutation M9 killed).
- **The config wall is down.** Scaffold untouched except the registry: no `'storage' is required`
  error anywhere. `deploy --dry-run --skip-build --skip-upload` completes and emits a NextApp CR
  with **no `spec.storage` key at all** — the chosen optional-by-absence shape (Q2/Q4), valid on
  every shipped CRD. (The first run failed only on the pre-existing lockfile requirement — an
  honest, unrelated error with its own fix instructions; a lockfile resolved it.)
- **The announced mode printed at INFO on the dry-run**, wording verbatim honest about the trade:
  "static assets will be served from the image (next start semantics): no CDN offload, no
  cross-deploy asset retention, and the in-flight skew window is unprotected (a browser still
  holding the previous build can 404 on its chunks once that revision scales away)" + docs link.
  Persona-legible: the 404 mechanism is spelled out, no jargon-only claims. **Condition 1 ✔**
  (deploy half; `doctor` gained the local, read-only `storage-mode` check reporting both modes as
  modes, not failures — mutation M8 killed).

## The six conditions

1. **Announce, every deploy** — ✔ empirically (incl. dry-run: "every deploy means EVERY deploy"
   test), build announces too, doctor reports the mode.
2. **Both mirrors** — ✔ `validate.ts:164→` and `loader.ts:26→` both flipped, in lock-step, each
   commented against the both-halves defect class; tests red if either rejects absence
   (mutations M2/M3 killed). A PRESENT block is still fully validated ("optional never means
   unvalidated" tests), and `provider:"none"` is rejected — absence is the only spelling.
3. **Every consumer nil-safe** — ✔ via the gate's preferred *scan*, not the enumerated list:
   `storage?` in `KnativeNextConfig` + `StorageBackedConfig` narrowing behind `hasStorage()`;
   `bunx tsc --noEmit` exits 0 in the worktree. `gc` prints "no object storage configured —
   nothing to reap … not a failure" and exits 0 before any cluster read (M4 killed);
   `preview.ts`'s optional-chain was made compiler-visible.
4. **Behavioural, mutation-proved** — ✔ for the in-suite halves: Dockerfile `COPY .next/static`
   + `public` asserted on the *generated* scaffold (M1: deleting the template COPY line reds the
   suite, exit-code-branched, restored clean), no-`ASSET_PREFIX` chain pinned end-to-end (deploy
   sets none and *clears an inherited one*; scaffold `next.config` gates `assetPrefix` on that
   env). **The live build→deploy→serve half is honestly deferred** — impl report and ADR both
   state the docker-build + HTTP-serve proof belongs to the lead-owned kind/OKE integration
   stage (workflow steps 3–4). That stage is a standing pre-merge gate anyway; see hold-point
   below.
5. **Docs, same PR** — ✔ all four files: `multi-cloud.mdx` gains "## Starting without object
   storage", `skew-protection.mdx` gains "## Without object storage" + the qualifier,
   `rollback.mdx` and `cli.mdx` gain "with object storage configured" qualifiers and links. No
   ADR/issue numbers in the added docs lines (house rule holds).
6. **Scaffold default** — ✔ (empirical, above).

## ADR-0047 claims vs the tree (the claims-ahead-of-code check)

Each Consequence verified: skew two-way split (rollback safer / in-flight weaker, `deploymentId`
half intact) matches the gate's Q1 analysis and the code; variant cache pod-local — ADR-0006
carries the dated amendment (status line + §Amendment); ADR-0011 amended (3 ADR-0047 refs);
`containerConcurrency`/scale-to-zero economics consequence present as required; GC no-op matches
`gc.ts` exactly; sentinel-rejection options table matches `validate.ts` behavior and the test at
`optional-storage.test.ts:123`; scope-boundary line ("does NOT provision storage") present. The
ADR's action-item 4 describes only what actually landed (the in-suite guards), not a live serve
test — no over-claim. One citation note: the ADR cites `docs/ux/ergonomics-ledger.md` row 3b,
which is **not in this branch's tree** (merge-base predates #819 by one commit) but **is on
origin/main now** (#819 merged, `7e2dd5b`); the branch doesn't touch the ledger, so merge/rebase
resolves it with no conflict. Not a defect — flagging so nobody reads it as one.

## Scope honesty

Every file in the 38-file diff traces to a condition: config/loader/validate (2, 3), asset-upload
+ deploy + build + gc + doctor + preview (1, 3), create + template (6), four docs pages (5),
ADR-0047 + two amendments, and tests (the ~4–6-line edits to pre-existing test files are fixture
updates forced by the type change). The parting-line rewrite in `create.ts` is row-3a-adjacent
polish inside the same ergonomics loop, tested, and is itself what the brief asked to judge — not
drift. Nothing beyond the six conditions.

## Hold-point for the lead (not a block)

Condition 4's live half — kind/OKE: storage-less scaffold `create → deploy`, curl `_next/static`
from the pod, confirm no `assetPrefix` in served HTML — is the workflow's standing lead-owned
integration gate (steps 3–4) and is explicitly listed as remaining in the impl report. Run it
before merge as usual; nothing in this PR claims it already happened.

*Scratch artifacts under the session scratchpad (`…/scratchpad/ux5/demo-app`); worktree left
untouched (verified `git status` clean apart from the implementer's own untracked report).*
