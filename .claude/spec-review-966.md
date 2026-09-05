# Spec review — PR #966 (Refs #952, design note §5 first step)

**Verdict: ISSUES_FOUND** (1 blocking, 2 advisory). Scope discipline and honest-status shape are
otherwise exactly right.

## Scope vs §5 — PASS

`gh pr diff 966 --name-only` = 5 files, **zero Go / CRD / operator paths**:
`apps/docs/content/docs/meta.json`, `apps/docs/content/docs/private-registries.mdx`,
`packages/kn-next/src/{__tests__/doctor-app-image.test.ts,__tests__/doctor.test.ts,cli/doctor.ts}`.
No `spec.imagePullSecrets`, no controller writes, no status condition — matches §5's
"deliberately not in the first step". PR body carries **no** `Closes/Fixes/Resolves`; it says
"Refs #952 … the issue stays open for the CRD half". Issue #952 is OPEN with 4 ACs; AC#1 and AC#4
(operator/CRD) correctly untouched.

## AC#2 (doctor warns) — MET, with a false-green (finding 1)
## AC#3 (docs end-to-end) — MET
`private-registries.mdx`: create the dockerconfigjson Secret → patch `<app>-sa` → **redeploy**
(the pull-secrets-resolve-at-pod-creation trap), per-registry `--docker-server` table (GHCR/OCIR/ECR
+ the 12h ECR token caveat), what the failure looks like (`ImagePullBackOff`, 401/403), and the
operator-owns-the-SA caveat. **No ADR/issue/PR numbers, no dates promised** — docs hygiene clean.
`<Callout type="warn">` matches existing usage (cli/hardening/install .mdx, no import needed).
Nav entry added under `---Platform---`; route `/docs/private-registries` matches the hint URL
constant `PRIVATE_REGISTRY_DOCS_URL`.

## Unreachable → never a pass — PASS
`outcome === "unreachable"` routes to the `unreachable` bucket → status `skip`, detail
"pullability not verified"; test *"registry unreachable => 'not verified' skip, NEVER a pass"*
asserts both `toBe("skip")` and `not.toBe("pass")`. RBAC-denied Secret/SA reads → `credsUnknown`
→ **warn** "could not verify", never pass (tested). SA `NotFound` treated as a fact (no SA
credential) → full warn (tested). Infra failure → `infraFailure` → error (matches #198/#963).

## Green-if-deleted — PASS (structural, no mutation run needed)
`appImageCheck()` **throws** if no `app-image` row exists, so deleting the check reds all 10 tests
in the new file; `doctor.test.ts` additionally pins `"app-image"` in the expected-id lists of both
the healthy and unreachable-cluster suites. PR reports 6 exit-code-prover mutations killed,
including "unreachable treated as pullable" and "warn deleted".

---

## Finding 1 (blocking) — a namespace dockerconfigjson Secret alone is passed as a credential, but
## Kubernetes never uses it unless it is attached

`doctor.ts` (new check e2): `saState === "has"` → pass; **else if `nsState === "has"` → pass**
("a kubernetes.io/dockerconfigjson Secret exists in `<ns>`").

Pods resolve pull secrets **only** from the pod spec or from the ServiceAccount they run under.
An unattached Secret in the namespace — for a different registry, or simply never patched onto
`<app>-sa` — does not make the pull work. So: private image + SA with no `imagePullSecrets` +
any unrelated dockerconfigjson Secret in the namespace ⇒ **pass**, while the pod goes
`ImagePullBackOff`. That is #952's own evidence path: the S3-V recovery was *copying the
namespace's dockerconfigjson secret and patching `knext-s3-app-sa`* — i.e. the Secret existed and
the deploy was still broken. The check goes green on precisely the cluster state the issue was
filed about.

The test *"private image + dockerconfigjson Secret in the namespace => pass"* pins this behavior
(its SA stub has no `imagePullSecrets`), so it is locked in, not incidental.

Caveat in fairness: this follows design §5 step 2/3 literally ("neither present ⇒ warning"), and
AC#2's wording ("no pull secret is configured in the namespace") is also satisfiable this way. The
design's rule is the defect, not a deviation from it — but `security.md`'s "a checker that goes
green when it cannot [establish the fact] is worse than none" applies, and the surrounding code is
scrupulous about exactly this elsewhere.

**Suggested fix (no CRD/operator work, stays inside §5):** make SA-attachment the pass condition
and demote namespace-Secret-only to **warn**: "a registry credential exists in `<ns>` but is not
attached to `<app>-sa` — pods resolve pull secrets from the ServiceAccount; patch it and redeploy",
reusing the existing hint. Update the corresponding test to assert warn.

## Finding 2 (advisory) — "warn BEFORE the pod does" overstates for the first deploy

The check enumerates `kubectl get nextapps --all-namespaces`; with no NextApp yet (a fresh
namespace — the S3-V scenario) it reports `skip` "no NextApps on this cluster". §5 step 1 says
"probe `spec.image` **/ the configured app image**", and the deploy-preflight half of AC#2 is
untouched (`deploy.ts` already has a preflight framework: `preflightCRSchema`,
`preflightImageRef`). Either add the local-config image path to the deploy preflight, or soften
the `doctor.ts` header comment (`warn BEFORE the pod does`) to match what ships — it warns on
already-deployed apps. The docs page is already honest here ("for every deployed app").

## Finding 3 (advisory) — `kubectl get secrets -n <ns> -o json` pulls every Secret's payload

Only `.items[].type` is read. `--field-selector type=kubernetes.io/dockerconfigjson -o name`
answers the same question without materialising unrelated secret data (DB passwords, tokens) in
the CLI process. Nothing is logged today, so this is hygiene, not a leak.
