# knext threat model (STRIDE-lite)

> **Published version:** a user-facing copy of this page is on the docs site at <https://knext-platform.dev/docs/threat-model>. Update both together; this file is the maintainer-level original.

> Closes the explicit `.claude/rules/security.md` requirement: *"Maintain a short threat model in
> `docs/security/`."* Companion to the mutating-endpoint audit (`mutating-endpoints.md`). Scope is
> knext's **real** components today — not a generic web-app checklist. Keep current when a trust
> boundary changes.

Last reviewed: 2026-07-23 (added §5 metrics-scrape TLS posture — self-signed cert + `insecureSkipVerify`, #489).

## Scope & assets
knext is the scale-to-zero Next.js adapter for Knative. The assets worth protecting:

- **Cluster state** — `NextApp` (and future `BackendService`) CRs and the Knative Services /
  NetworkPolicies the operator reconciles from them. The operator is the **single source of truth**
  (ADR-0001); corrupting it corrupts every deploy.
- **The published images** — `ghcr.io/getknext-dev/file-manager` (app/gateway) and
  `…/kn-next-operator`, plus their base images. These are signed and run in customer clusters.
- **Secrets** — `CACHE_INVALIDATE_TOKEN`, the gateway↔backend shared token, `DATABASE_URL`,
  registry creds. Live only in K8s Secrets / env (security.md).
- **The ISR / data cache** — Redis-backed (`cache-handler.js`); poisoning it serves wrong content.

## Trust boundaries (the five reviewed paths)
1. **Operator reconcile path** — kube-apiserver → `nextapp_controller.go` Reconcile → Knative /
   NetworkPolicy objects.
2. **Gateway↔backend calls** — the Next.js gateway → cluster-local `BackendService` (h2c, no public
   ingress; ADR-0004). *Design-now/build-later, but in scope for the threat surface.*
3. **The cache-invalidate endpoint** — `apps/file-manager/src/app/api/cache/invalidate/route.ts`
   (`POST`) and `DELETE /api/cache/events`.
4. **The supply chain** — base image → buildkit build → SBOM/Trivy/cosign → GHCR → cluster pull.
5. **The metrics scrape** — Prometheus → the operator's HTTPS metrics endpoint (self-signed cert
   by default; `config/prometheus/monitor.yaml`, `cmd/main.go`).

---

## 1. Operator reconcile path

| STRIDE | Threat (concrete) | Mitigation in repo | Residual / action |
|---|---|---|---|
| **S**poof | A workload forges a `NextApp` to make the operator stand up a Service it shouldn't. | RBAC on the CRD; operator runs with a least-privilege ServiceAccount, `AutomountServiceAccountToken: false`. | Document the minimal Role in the bundle. |
| **T**amper | Untrusted CR sets a mutable / `:latest` image, drifting the CVE surface. | `nextapp_controller.go` **rejects non-digest refs**; `hack/check-no-latest.sh` + the new `scripts/check-base-images-pinned.sh` keep manifests + base images pinned. | — |
| **R**epudiate | No record of what the reconciler changed. | Reconcile emits K8s Events + `status.Conditions`. | Conditions population is partial (CLAUDE.md §9) — finish it. |
| **I**nfo disclosure | Secret values echoed into CR `status` / logs. | Operator reads secrets by reference, never inlines them; never logs values. | Lint guard `block-secrets.sh`. |
| **D**oS | A flood of CRs / requeues starves the controller. | Single-threaded workqueue with backoff; Knative scales the data plane to zero. | Consider a reconcile-rate alert. |
| **E**lev. of priv. | Operator over-broad RBAC lets a compromised CR escalate. | Least-privilege ClusterRole (`config/rbac/role.yaml`, generated from `+kubebuilder:rbac` markers); no cluster-admin; core Secrets: **`get` only**, used for metadata reads by the zone-function credential allowlist (see below). | Periodic RBAC review. |

### Operator RBAC: Secrets (#1966)

**Finding.** The manager ClusterRole used to carry `get;list;watch;create;update;patch;delete` on
core `secrets` cluster-wide. That is the widest read primitive in the cluster: a compromised
operator pod (or its ServiceAccount token) could read every Secret in every namespace, including
other tenants' and the cloud-provider credentials stored there.

**Inventory (file:line of the operator's Secret handling, as of this change).** The Go source
under `packages/kn-next-operator` has **no** Secret `Get`/`List`/`Watch`/`Create`/`Update`/`Delete`,
no `Owns(&corev1.Secret{})`, no `Watches` on Secrets, and no typed or unstructured Secret client:

| Surface | What the operator actually does | Who touches the Secret |
|---|---|---|
| `spec.secrets.envFrom` / `envMap` (`nextapp_controller.go` env assembly) | Emits `envFrom.secretRef` / `valueFrom.secretKeyRef` **by name** into the Knative Service | The **kubelet** resolves it when the pod starts |
| `spec.database.secretRef` / `roSecretRef` (`database_binding.go`) | Rewrites those names onto `DATABASE_URL(_RO)` `secretKeyRef` entries, in memory | The **kubelet** |
| Image pull (`image_prewarm.go`) | Reads the app **ServiceAccount**'s `imagePullSecrets` (a list of names) | The **kubelet** pulls |
| Webhook / metrics serving certs | Mounted as volumes (cert-manager) | The **kubelet** |
| Managed-database DSN mirroring | **Removed** (ADR-0025); this was the only code that ever needed Secret read/write | n/a |

The grant was a leftover from the removed mirroring path, never exercised.

**Decision (least privilege, scored with `jev`: drop 1.00 vs resourceNames / namespaced Roles /
get-only 0.00).** Remove the Secrets rule entirely. `resourceNames` and per-namespace Roles were
rejected because the operator has no fixed Secret names and no code path to protect with them;
narrowing a grant nothing uses only leaves a smaller dormant one. A controller-runtime cache
would only need list/watch on Secrets if the code read them; it does not, so no label-filtered
cache is required.

**Enforcement (both halves).**
- `internal/controller/rbac_secrets_guard_test.go` parses every Role/ClusterRole under
  `config/rbac/` **and** scans every `+kubebuilder:rbac` marker (wildcards `*` included); any
  core-Secrets grant fails unless it has a justified entry in `secretsGrantAllowlist` (since zone
  functions: `get`; since the zone identity: `create`/`update` on the zone's own signing key, both
  below), and a justified ClusterRole grant still cannot carry cluster-wide `list`/`watch`.
- `internal/controller/rbac_narrowed_envtest_test.go` runs the real controller wiring as a
  client-cert identity bound to exactly the shipped `role.yaml`: a NextApp that references
  Secrets by name converges (Knative Service, finalizer, status) while that identity is denied
  every Secrets verb except `get`, `create` and `update`, cluster-wide and namespaced (with
  positive and negative RBAC controls, and an assertion that those three ARE allowed).

**Residual.** (a) Anyone who may create a `NextApp` can still *reference* any Secret in their own
namespace by name; the kubelet, not the operator, resolves it — restrict `NextApp` create/update
with namespace RBAC. (b) The operator still holds broad write on the objects it owns
(Knative Services, ServiceAccounts, NetworkPolicies, DaemonSets) cluster-wide; per-namespace
operator install is the next narrowing step and is not done. (c) **Indirect Secret access remains.**
Dropping the Secrets rule removes the operator's *direct* access only. Because the operator can
create Knative Services (and thus pods) cluster-wide, a compromised operator can still reach any
Secret by creating a pod that mounts or exposes it; a namespace boundary does not bound a
cluster-wide operator. Mitigations: per-namespace operator install, or an admission policy
restricting which Secrets operator-created workloads may reference.

### Operator RBAC: the zone-function `get` on Secrets (#2052)

**What changed.** Zone functions (`BackendService`, ADR-0004 Amendments 1 and 2) bring a
credential allowlist: a function may reference a Secret only if it is its own zone's database
Secret (`spec.database` of the zone, known by name from the `NextApp`) or a Secret **marked** for
its zone (the label `apps.kn-next.dev/zone=<zone>`, or an `ownerReference` to the zone's
`NextApp`). Checking the mark needs the Secret's metadata, so the manager ClusterRole gains
**`get` on `secrets` and nothing else**: no `list`, `watch`, `create`, `update` or `delete`.

**How it is used.** Only the `BackendService` reconciler reads a Secret, only one the function's
spec names, through the **uncached** `APIReader` (no informer, so `list`/`watch` are never
needed), and as a **metadata-only** `PartialObjectMetadata` GET: the operator never receives a
Secret's data. A Secret that cannot be read is treated as unmarked, so the function is refused
(fail closed).

**Blast radius.** A compromised operator could `get` a Secret whose name it already knows; it
cannot enumerate Secrets. That is strictly less than the indirect access in residual (c) above,
which already exists. The zone-function reconciler itself still does not create Secrets; the
zone identity's grant is the next section.

**What is the control, and what is not.** The allowlist above, applied only through a two-sided
binding (the zone must also list the function in `spec.backends`), and the operator-owned
per-function ServiceAccount (no Role, no RoleBinding, automount off; the spec has no
`serviceAccountName`) are the data-sovereignty control: a function holds no credential for
another zone's database. The check for another zone's CNPG `-rw`/`-ro` host in an env literal is
a **lint** (a warning condition): an IP address, an `ExternalName` Service or a URL built at run
time gets past it. The function `NetworkPolicy` admits the Knative data path (activator,
gateway) and stops direct dials; it cannot express "only the owning zone", is defense in depth,
and is enforced only on a policy-capable CNI (not flannel).

**Enforcement.** `rbac_secrets_guard_test.go` (the one justified `get` entry, no list/watch),
`rbac_narrowed_envtest_test.go` (`get` allowed, every other verb denied),
`backendservice_rbac_envtest_test.go` (the reconciler under the shipped role sets the zone's
`ownerReference`, refused without `nextapps/finalizers`), the per-source allowlist tests in
`backendservice_sovereignty_test.go` and `backendservice_envtest_test.go`, and the Calico
function leg of `test/networkpolicy-enforcement-drill.sh`.

### Zone-function binding: `update` on `backendservices` is `get` on the zone's database Secret (#2497, #2526)

**The residual, stated plainly.** The two-sided binding (the function names its zone in
`spec.zone`, the zone lists the function in `spec.backends`) matches **names only**. It stops
someone who may **create** a `BackendService` from pulling in a zone's database Secret under a new
name. It does **not** stop someone who may **update** an already-bound `BackendService`, or delete
it and create one with the same name:

- The principal needs `update` (or `create` after a delete) on `backendservices` and nothing else:
  no Secret read, no `NextApp` write.
- They change `spec.image` to an image they chose. The operator re-renders the function, and the
  function's `envFrom` or volume still names the zone's own database Secret, which the credential
  allowlist permits. That image now runs with the zone's database credentials mounted and the zone's
  JWKS mounted.
- The zone sends its users' identity tokens (`sub`) to that image on every call.

So **`update` on `backendservices` in a namespace is equivalent to reading the database Secret of every
zone that binds a function there, and to receiving those zones' users' tokens. This holds with no pin and
with only the image pin below** (see "What it does not cover": the image pin binds the image only). For the BackendService route it is
**closed for a zone that sets the spec pin** (next section), apart from the residuals listed there. Grant
`update`/`patch` on `backendservices` (and `create`, since a delete followed by a create is the same act)
only to principals who may already read those Secrets. A GitOps controller that applies the
`BackendService` has this power by construction. This is not visible in the cluster's RBAC for
Secrets, which is what makes it easy to miss in a review.

**The partial control: the image pin.** The zone's optional pin (`NextApp.spec.backends[].image`, ADR-0004 Amendment 3, the
CLI's `backends[].image`): `"@sha256:"` plus 64 lowercase hex characters. With a pin, the operator
renders the function only while the digest of its `spec.image` equals the pin exactly. Any other
digest, an image with no digest, or an ambiguous reference refuses the function: `Ready=False`, reason
`BindingImageMismatch`, the Knative Service and NetworkPolicy removed, nothing mounted, no JWKS. The pin
is the zone owner's statement of what it agreed to bind, written where only a principal with `update` on
the `NextApp` can change it, so the principal above cannot move it. It is positive evidence read from the
two specs (never from a Secret read or any request that can fail), so a transient error cannot cause
the refusal and cannot undo it.

**The control that closes the BackendService route: the spec pin (#2526, ADR-0004 Amendment 4).** The
zone's optional `NextApp.spec.backends[].specDigest` (`"sha256:"` plus 64 lowercase hex characters, the
CLI's `backends[].specDigest`, printed by `knext deploy function`) pins a digest of the function's
**image, `env`, `envFrom` and `volumes`**: everything in `BackendServiceSpec` that decides what code
runs and what it can read. The operator re-computes the digest from the live `BackendService` on every
reconcile (canonical form: ADR-0004 Amendment 4, shared vectors recomputed by the Go operator and the TS
CLI) and renders the function only while it equals the pin. Any other spec (an env var, an `envFrom` or a
volume added; any of them changed or reordered; another image) refuses the function: `Ready=False`, reason
`BindingSpecMismatch`, the Knative Service and NetworkPolicy removed, nothing mounted, no JWKS; the message
names both digests. Like the image pin it is positive evidence read from the two specs, so a transient
read error can neither cause the refusal nor undo it, and it is never rendered into the zone (golden).
The classification of every `BackendServiceSpec` field (hashed, or excluded with a reviewed reason) is
enforced by `TestEveryBackendServiceSpecFieldIsBoundOrReviewed`, so a field added later cannot reach the
pod outside the pin without a decision. For a zone that sets it, **`update` on `backendservices` is no
longer equivalent to reading the zone's database Secret through the `BackendService`**: the
`NODE_OPTIONS=--import=...` path below is refused before anything is mounted.

**What the spec pin leaves (residuals).**

- **Contents of the objects the spec names.** The digest binds the *names* of the Secrets and ConfigMaps
  the function reads, not their data. A principal who can write a ConfigMap the function mounts, or a
  Secret marked for the zone, can change what the function reads, and what it executes if the pinned
  image loads code or configuration from it. That needs write on that object, not on `backendservices`;
  namespace write access to Secrets and ConfigMaps stays inside the namespace trust boundary
  (`ZoneLabel` is writable by anyone who can write Secrets).
- **A Secret the zone itself provides.** If the pinned spec references a Secret marked for the zone, the
  function has it by design; the pin is the zone's statement that it may.
- **Excluded settings** (each with a reviewed reason in `specPinExcludedFields`): `port` (a writer can
  aim traffic at another listener of the same pinned image), `protoVersion` (a writer can misreport the
  contract version to the zone's version gate), `scaling`, `resources`, `imagePullSecrets` (the kubelet
  uses them only to authenticate the pull of the image by digest; the pod does not mount them),
  `language` and `wakeAhead` (nothing is rendered from them into the function), and `zone` (immutable;
  it is the binding itself).
- **Optional, per zone.** A zone that sets neither pin keeps the name-only binding; a zone that sets only
  `image` keeps the residual below. List order counts (`env` order decides `$(VAR)` expansion), so a tool
  that reorders a list makes the pin mismatch and the function is refused (fail closed).
- **Hand-written specs need the operator's digest.** `knext deploy function` hashes the spec it applies.
  A `BackendService` with `env`, `envFrom` or `volumes` added by hand hashes differently; the refusal
  message carries the digest the operator computed so a reviewer can pin it. Pinning a digest copied
  from a refusal nobody reviewed pins whatever is on the cluster.
- **Whoever can write the `NextApp` can move the pin**, as for the image pin.
- **Quantities and defaults.** The digest is computed over the stored object: a `sizeLimit` or a
  `resourceFieldRef.divisor` the apiserver re-renders differently from how it was written can make a
  hand-written spec mismatch (fail closed). The CLI emits neither.

**What the image pin does not cover.**

- **The image pin binds the image content only; it does not close the exposure above.** The function's `env`,
  `envFrom` and `volumes` are all in the `BackendService` spec (it has no command or args field) and stay with whoever
  can write it. Reviewer-verified on Node v25: a writer keeps the pinned digest and adds
  `spec.env: NODE_OPTIONS=--import=data:...`; that code runs inside the pinned image with the zone's
  db-bind mounted and its users' tokens arriving. The credential allowlist does not catch it (it checks
  Secret and ConfigMap references, not what an env value makes the image execute). The fix is the spec
  pin above (#2526). A zone that sets only the image pin, or none, keeps this residual, and the RBAC
  advice above applies to it.

- **No pin, no image control.** The pin is optional (adding it to every existing zone would break them), so
  a zone that does not set it keeps the name-only binding for the image too.
  Check which zones pin: `kubectl get nextapps -o jsonpath` over `spec.backends[*].image`.
- **Whoever can write the `NextApp` can move the pin.** That principal can already name a Secret in the
  zone's own `spec`, so nothing is lost; the pin narrows the set of people who can redirect the
  zone's credentials, it does not remove the set.
- **It binds content, not provenance.** A pin says "this digest", not "built by us": a malicious
  image that the zone owner pins is bound. Provenance is the supply-chain controls (signing, SBOM).
- **Rotation is two writes.** A new image and a new pin cannot land in one instant. Between the two
  writes the function is refused and renders again once they agree (a cold start). Apply both in one
  `kubectl apply -f` (or one commit for a GitOps controller) to keep the window to a few seconds.
- **The zone does not render the pin, and does not report the refusal.** The zone's pod template is
  byte-identical with and without it, and its `BackendBindings` condition still reads `Bound`: a
  name-level fact. (A refused function stops reporting a served version, so the zone drops
  `<NAME>_SERVICE_PROTO_VERSION` and its calls fail closed, as for any refusal.) Read the refusal on the
  function: `kubectl get backendservice <name> -o jsonpath` over `status.conditions`, or the
  `knext_backendservice_refusals_total{reason="BindingImageMismatch"}` counter.
- **Proved on kind, not on OKE.** The kind lane swaps the image with `kubectl` and asserts the
  function's Knative Service and pods are gone, so nothing mounts the zone's database Secret on its
  behalf. The refusal is a delete of two objects and does not depend on the CNI.

**Enforcement.** `backendservice_image_pin_test.go` (the comparison table: no pin, matching digest,
another digest, tag-only, tag containing the digest text, two digests, uppercase hex, a longer digest; the
verdict; a mismatch is definitive even with an unreadable Secret; the zone's rendered Knative Service
byte-identical with and without a pin and across a function image swap),
`backendservice_spec_pin_test.go` (the shared vectors the TS CLI recomputes; env, envFrom and
volume additions, a reorder and an image change all mismatch; tuning fields do not; the field coverage
guard and its behavioural check against the rendered objects; the zone's rendered Knative Service
byte-identical with and without a spec pin), `backendservice_spec_pin_envtest_test.go` (env added under
a pinned spec is refused and nothing renders or mounts; the same for envFrom and a volume; a matching
spec renders; no pin keeps today's behaviour; rotation with both sides changing together updates in
place; either order of two writes refuses in between; a Secret read error leaves a matching pinned
function alone and does not hide a mismatch; the CRD rejects each malformed pin),
`backendservice_image_pin_envtest_test.go` (a swapped image is refused and its Knative Service
removed; a re-created function with another image is refused; a matching pin renders; no pin keeps
today's behaviour; the function recovers in place when the image returns; rotation with both sides
changing together updates the same Knative Service; either order of two writes refuses in between; a
Secret read error leaves a matching pinned function alone; the CRD rejects each malformed pin), and the
mutation prover `scripts/mutation-prove-2052-backendservice.mjs` (a row per rule of the comparison).

### Operator RBAC: the zone signing key and JWKS (#2051)

**What changed.** A zone with a two-sided function binding gets one Ed25519 signing key, generated
in the operator (ADR-0004 Amendment 1 Decisions 9 and 11). The NextApp reconciler creates and
rotates the zone's Secret `<zone>-knext-signing-key` and its JWKS ConfigMap `<zone>-knext-jwks`.
The manager ClusterRole gains **`create` and `update` on `secrets`** (on top of the existing `get`)
and **`get`, `create` and `update` on `configmaps`**. Still **no** `list`, `watch`, `patch` or
`delete` on either.

**How it is used.** Both objects are read through the **uncached** `APIReader` (no informer, so
no list/watch) and written with `Update` carrying the read `resourceVersion` (a concurrent writer
loses with a Conflict; nothing is blind-patched). The reconciler reads the key Secret's data,
which is new: it must hold the current key to rotate it. The `ownerReference` to the zone's
`NextApp` is set once, at create, and never changed, so no `delete` is needed even under
`OwnerReferencesPermissionEnforcement`. A zone that loses its bindings keeps both objects; the
owner reference collects them with the `NextApp`. An object of either name that the zone's
`NextApp` does not control is never written (reported as a conflict instead). Key material never
leaves the Secret: the JWKS type has no private member, rotation state lives in timestamp
annotations, status and events carry only the public `kid`, and every error the key path returns
is redacted (`redactKeyMaterial`) so an echoing apiserver or admission webhook cannot carry the key
into a log line, an event or status.

**Blast radius.** RBAC cannot name these objects: `resourceNames` does not apply to `create`, and
the names are per zone. So a compromised operator could now also **overwrite** any Secret or
ConfigMap whose name it knows, in any namespace (it still cannot enumerate them). Tampering is
the new capability; reading was already possible (`get`), and residual (c) above already lets a
compromised operator reach any Secret through a pod it creates. A function's verifier trusts its
zone's JWKS ConfigMap, so anyone who can write ConfigMaps in the namespace can make that zone's
functions accept their own key: **the namespace is the trust boundary**, as for the zone label.

**Narrowing: the operator's write policy (#2462).** The install bundle ships a
`ValidatingAdmissionPolicy` and its binding (`config/admission`) that confine the operator's
ServiceAccount, and only that identity, to the names it writes: `Opaque` Secrets ending
`-knext-signing-key` and ConfigMaps ending `-knext-jwks`, on create, update and delete (the type is
checked on create and update). Any other write by the operator
is refused with 403 whatever its RBAC says, which removes the overwrite capability described in the
blast radius above. Every other principal is untouched: the garbage collector that deletes a zone's
objects with its `NextApp`, the namespace controller, a tenant, a human who deletes the key Secret
to replace it, and a ServiceAccount with the operator's name in another namespace.
- *Identity.* One exact username, `system:serviceaccount:<namespace>:<name>`, spelled as separate
  literals so `config/default` rewrites the namespace and the prefixed name from the real
  ServiceAccount. A literal left behind would never match and the operator would be unrestricted
  with no error anywhere, so the rendered-bundle test asserts the confined identity equals the
  ClusterRoleBinding subject and the manager Deployment's `serviceAccountName`.
- *`failurePolicy: Fail`* (jev 0.95). The policy confines only the operator, through a plain
  equality that cannot error, and runs in the apiserver (no webhook, no network hop), so Fail can
  only ever refuse the operator itself; Ignore would turn an evaluation error into an unrestricted
  operator.
- *Cannot be lifted by the operator.* The shipped role holds nothing on admission policies; a scan
  of every rule under `config/rbac` and an envtest attempt (RBAC refuses the delete and the edit)
  pin it.
- *Lockstep with the code.* The allow-list is two suffix lists in the policy.
  `operator_write_inventory_test.go` type-checks the operator's source with `go/packages`, finds
  every Secret and ConfigMap write by static type (and every write whose kind the type hides:
  interface-typed, unstructured or metadata-only objects, and `"Secret"` / `"ConfigMap"` kind
  literals), and fails if the code and the policy disagree in either direction. Today the operator
  writes exactly two objects, and no other Secret or ConfigMap: the leader-election lock is a Lease
  (pinned in `cmd/main_test.go`), and the `config-network` ConfigMap in the bundle is applied by
  whoever installs it, not written by the operator.
- *Type (round-2 review finding).* The name alone was a bypass. A Secret of type
  `kubernetes.io/service-account-token` named `x-knext-signing-key`, annotated
  `kubernetes.io/service-account.name: <privileged ServiceAccount>`, is filled in by the tokens
  controller with that ServiceAccount's credential, and the operator can `get` the Secret it wrote:
  it becomes that ServiceAccount (the envtest rows reproduced the create succeeding before the fix).
  The policy therefore also admits only `Opaque` on create and update (variable
  `allowedSecretType`; a delete creates no credential and is not checked). A Secret's type is
  immutable, so checking the new object also refuses an update of a foreign token Secret that
  carries an allowed name. The check reads the field as `dyn(object).type` and only for Secrets,
  because the policy also matches ConfigMaps, which have no type. The scan pins the code side: the
  writer's Secret literal must set `Type` to the constant `Opaque`, nothing may assign a Secret's
  `Type` afterwards, and the policy's allowed type must equal it.
- *Version floor.* `ValidatingAdmissionPolicy` is `admissionregistration.k8s.io/v1` from
  Kubernetes 1.30, the documented server floor (support matrix, and now the install page too). The
  bundle is one artifact; there is no policy-free variant (jev: align the docs 1.00, ship a second
  bundle 0.00). On an older cluster the apply rejects the two policy objects and the rest of the
  bundle applies, leaving the operator unrestricted.

**Defence in depth: the function mounts the JWKS only if the zone controls it (#2464).** Before it
renders a function, the BackendService reconciler reads the metadata of `<zone>-knext-jwks`
(a `PartialObjectMetadata` GET through the uncached `APIReader`; the `get` on `configmaps` that
the zone-key writer already holds, so no new grant, and still no informer) and mounts it only if
the zone's `NextApp` is its **controller** by UID (the test the NextApp reconciler applies before
it writes the object). If the ConfigMap exists and the zone does not control it (no owner,
another object, another zone, or a `NextApp` of the same name with a different UID, as left by an
earlier incarnation), the function is rendered with **no JWKS volume at all**: it still starts and
answers its health check, and refuses every other call (fail closed). The reconciler reports
`JWKSTrusted=False` and `Ready=False` with reason `JWKSUntrusted` (computed in
`computeBackendServiceVerdict`), records one Warning event per transition and counts the
transition in `knext_backendservice_refusals_total{reason="JWKSUntrusted"}`. While the ConfigMap
does not exist yet the optional mount is kept, so the kubelet fills it as soon as the operator
creates it without a new revision. A failed read returns an error and leaves the rendered function
as it was: it says nothing about ownership.

**Residual (#2464).** (a) An `ownerReference` is a claim: anyone who can write ConfigMaps in the
namespace and can read the zone's UID can forge one, so this closes an accidental or early squat
and a stale object, not a deliberate forger; the namespace stays the trust boundary. (b) The check
is point-in-time. It runs on each reconcile of the function (on any change to a `NextApp` in the
namespace, which includes the zone's own `ZoneSigningKey` condition flipping to
`JWKSConfigMapConflict`, and at the latest on the ten-minute re-check), so a ConfigMap replaced
after the last check is still mounted by running pods until then: the volume names an object, not
a UID. (c) The absent case keeps the optional mount, so a squatter that creates the ConfigMap
between the read and the kubelet's next volume sync is mounted until the next check. (d) Ownership
says nothing about content: an in-place edit of the zone-owned JWKS is repaired by the zone's
steady re-check (see the residuals above), not detected here.

**Enforcement (#2464).** `backendservice_jwks_test.go` (the ownership classification, the render
with and without the volume, the verdict and its transition-only warning),
`backendservice_jwks_envtest_test.go` (a squatted, foreign-owned, other-zone and
same-name-other-UID ConfigMap is not mounted; a zone-controlled one is; an absent one keeps the
optional mount; a replaced one is unmounted and mounts again once it is gone; the read goes through
the uncached reader; a read failure changes nothing), and the mutation prover
`scripts/mutation-prove-2052-backendservice.mjs` (one row per rule).

**Residual.** (a) The write policy (#2462, above) bounds **name and Secret type, not ownership**. A
compromised operator can still overwrite an `Opaque` Secret or a ConfigMap that carries an allowed
name and belongs to someone else (another zone's `<zone>-knext-signing-key` or
`<zone>-knext-jwks`); the reconciler's own
controller-ownership test refuses that in normal operation, the policy does not enforce it.
Requiring a controller `ownerReference` to a `NextApp` on update and delete would close it, and was
left out on purpose (jev 1.00 for names only): it risks breaking crash recovery and the adoption of
objects an earlier operator made, and the task is the names. The policy also leaves the operator's
reads alone, can be removed by anyone with rights on admission policies (a cluster admin; the
operator has none), and needs Kubernetes 1.30. A write that bypasses the apiserver's admission
chain (etcd directly) is out of scope. The guard behind the lockstep follows calls and types it can
see: an object of an interface type handed in from another function, or a client reached by
reflection, is not followed (the first is refused outright: a dynamic write must build its object
locally). (b) The operator cannot watch Secrets, so a deleted key or an
edited JWKS is restored on the zone's next reconcile (at most ten minutes, the steady re-check),
not instantly. (c) The rotation wait trusts the operator's clock: a new leader whose clock runs
ahead could switch signing early by the skew; keep nodes on NTP. Within one operator, both waits
(the bound and the overlap) count from a clock reading taken after the apiserver confirmed the
write they follow, so a slow write lengthens a wait and never shortens it. (d) A rotation trusts the
kubelet's ConfigMap sync to finish within the propagation bound (default 120 s,
`--zone-signing-key-propagation-bound`, at least 90 s: a default kubelet's 60 s sync stretched by up
to 50% jitter, plus a 30 s margin in the default); a slower kubelet sync must raise it. A bound under
the default still rotates and is reported on the `ZoneSigningKey` condition. (e) client-go prints request and response bodies at klog verbosity 8 and above, Secret
data included; never run the operator that verbose in production.

**Enforcement.** `rbac_secrets_guard_test.go` (the justified entries, and
`TestZoneIdentityRBACIsExactlyGetCreateUpdate` pinning both rules to exactly those verbs),
`rbac_narrowed_envtest_test.go` (create/update allowed, list/watch/patch/delete denied),
`zone_signing_key_rbac_envtest_test.go` (the real reconciler under the shipped role with
`OwnerReferencesPermissionEnforcement` on creates, owns and rotates the key, and fails without the
Secrets or ConfigMap verbs), and `zone_signing_key_envtest_test.go` / `zone_signing_key_test.go`
(rotation order, crash safety at every write, ownership, conflicts, no key in a function pod, and
no key material in events, logs, status or errors).

**Enforcement (#2462).** `operator_write_policy_envtest_test.go` (the shipped policy on a real
kube-apiserver: the operator identity, bound to the shipped role, writes its two names and is
refused any other on create, update and delete; refused a service-account-token, dockerconfigjson or
tls Secret under an allowed name, and cannot update a foreign token Secret that carries one; cannot
remove its own binding; other principals and a same-named ServiceAccount elsewhere are untouched;
the real zone reconciler creates and rotates under the policy; and the proof reddens when the JWKS
name leaves the allow-list), `operator_write_policy_bundle_envtest_test.go` (the rendered bundle's
policy on a real apiserver, identity taken from the rendered ClusterRoleBinding, token Secret
refused),
`operator_write_inventory_test.go` (the type-checked scan of the operator's source, the lockstep with
the allow-list in both directions, the Opaque-only Secret type, and the no-self-edit scan of
`config/rbac`),
`internal/install/operator_write_policy_test.go` (the policy is strict, is in the default overlay,
and in the rendered bundle confines exactly the identity the operator runs as), and the mutation
prover `scripts/mutation-prove-2462-operator-write-policy.mjs` (one row per rule). Every committed
mutation prover, this one and the other sovereignty provers included, is re-run on a schedule against
both `main` and `integration/v2` by `.github/workflows/mutation-prover-nightly.yml`. The full run over
both refs is weekly during the release-candidate window, and `integration/v2` alone, where the
sovereignty provers live, is re-run daily (Monday to Saturday) in addition. A red, timed-out or
cancelled leg opens or updates the shared "Mutation provers RED" issue.

## 2. Gateway ↔ backend calls (zone → function)

**The model that shipped (Z7, ADR-0004 Amendment 1).** A zone calls a bound `BackendService`
function with a per-call EdDSA (Ed25519) JWT. There is no shared token.

- **Stage.** Zone functions are Beta and exist on the v2 line only; released 1.x has none of this.
- **Per-zone keys.** Each zone with a two-sided function binding has its own Ed25519 key in the
  Secret `<zone>-knext-signing-key`. The operator generates and rotates it; the private half never
  reaches a function pod.
- **JWKS.** The public half is published in the ConfigMap `<zone>-knext-jwks` and mounted into the
  functions the zone is bound to, only when that zone's `NextApp` controls the ConfigMap (see the
  JWKS mount rule in §1).
- **Issuer and audience.** `iss` is `knext:zone:<namespace>/<zone>`; a function accepts only its
  bound zone's issuer. `aud` is `knext:fn:<namespace>/<function>`, so a token minted for one
  function is refused by another.
- **Method binding.** The token carries `method` (`/<package>.<Service>/<Method>`) and the function
  refuses a token whose method is not the one being called.
- **Life.** `exp - iat` is 60 s, and a verifier allows 5 s of clock skew.
- **Rotation.** A new public key is published and given the propagation bound (default 120 s,
  minimum 90 s) to reach running functions before the zone signs with it; the old key stays for an
  overlap hour. Rotation state lives in Secret annotations (residuals (b)–(d) of the signing-key
  section in §1 apply).
- **Write policy.** The operator can write only an `Opaque` Secret named `*-knext-signing-key` and a
  ConfigMap named `*-knext-jwks`, enforced by a ValidatingAdmissionPolicy (Kubernetes 1.30+). A
  function that references a signing-key Secret or another zone's JWKS is refused. See "Z7 operator
  write surface" in ADR-0004 and residuals (a)–(d) in the signing-key and JWKS sections of §1.

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **S**poof | A pod impersonates a zone to call a function directly. | Functions are labelled `networking.knative.dev/visibility: cluster-local`. That is Knative's setting, not a guarantee: on some installs a DomainMapping is routed on the public load balancer regardless (on OKE keep private apps behind a tunnel). The token is the control. Every call needs a JWT signed by the zone's own key, verified against its JWKS, with the function's `aud` and the call's `method`. Functions hold no signing key, so they cannot call each other. | Residual G1 below: a captured token is replayable for up to 60 s, with a body of the attacker's choosing. A same-namespace actor who can write ConfigMaps can forge the JWKS owner reference (JWKS residual (a) in §1). |
| **T**amper | In-cluster MITM rewrites an h2c request or its response. | The token binds `iss`, `aud`, `method`, `sub` and a 60 s life, so a request cannot be re-aimed at another function or method. A default-on internal-only `NetworkPolicy` limits who can reach the pod. | Residual G2 below: the response is not authenticated, and the request body is not covered by the token. NetworkPolicy is enforced only on a CNI that implements it (not flannel). |
| **R**epudiate | No attribution for a function mutation. | The token names the zone (`iss`) and the user (`sub`); the function can log both. | The `sub` is the zone's assertion, not the user's (G3 below). |
| **I**nfo disclosure | A function leaks data, or a zone reads another zone's data through it. | cluster-local label (Knative's; see Spoof); the function holds no other zone's DB credential (allowlist) and no signing key. | Plaintext h2c: anything on the pod network path can read traffic (G2). |
| **D**oS | A zone floods a scaled-to-zero function on cold start. | Knative concurrency limits and revision autoscaling; the verifier rejects a bad token before any handler work. | — |
| **E**lev. of priv. | Implicit pod-to-pod trust; a call crosses a namespace or a function. | **No implicit trust**: a zone-issued, function-audienced token is required; a cross-namespace token is refused. | Residual G3 below: the function trusts the zone's `sub`. |

### Gateway ↔ function residuals (G1–G3)

Each is stated with likelihood and impact, the mitigation that exists today, and what closes it. They
sit beside the operator-side residuals (a)–(d) of the signing-key and JWKS sections in §1 and the
open items in ADR-0004's "Z7 operator write surface" (names-only binding, read-error removal); none
of those is repeated here.

**G1. Replay within the token's life (#2510).** The token has no `jti` and the verifier keeps no replay
cache. An attacker who captures a token on the pod network can replay it, unchanged, against the
**same** function and the **same** method for up to 60 s plus 5 s of skew. The token carries no
hash of the request body, so the replay is not of the original call: it runs that RPC with an
**attacker-chosen body**. This is the same missing integrity as G2.
- *Likelihood:* low. Capture needs a position on the pod network, which is plaintext h2c, and on a
  flannel cluster (OKE, OrbStack) the NetworkPolicy that would limit who can reach the pod is not
  enforced.
- *Impact:* bounded. `aud` limits it to one function and `method` to one RPC. A replayed call
  repeats whatever that RPC does, so a non-idempotent write is the worst case.
- *Mitigation today:* the 60 s life; `aud` and `method` binding.
- *Closes it:* a `jti` claim plus a short replay cache in the verifier (per-pod memory; lost on
  scale-to-zero, which is acceptable because the life bounds it), or mTLS so the token is not
  capturable in the first place.

**G2. Responses are not authenticated (#2511).** The token authenticates the zone to the function. Nothing
authenticates the function's reply to the zone, and nothing integrity-protects the request body.
An attacker in the path can tamper with either.
- *Likelihood:* low. It needs the same pod-network position as G1.
- *Impact:* moderate. The zone would act on a forged result; confidentiality of traffic is also
  absent.
- *Mitigation today:* the internal-only NetworkPolicy where the CNI
  enforces it, and the request-side token. None of these authenticates the reply.
- *Closes it:* mTLS between the zone and the function (a service mesh, or workload certificates).
  This is the stated closure; it is not built.

**G3. The function trusts the zone's `sub` (#2512).** The user the function sees is whatever the zone put in
`sub`. The function cannot check that this user signed in. A compromised zone pod can therefore mint
any user for **its own** functions (the key, `iss` and `aud` still confine it to them).
- *Likelihood:* follows the compromise of a zone pod, which already holds that zone's key and its
  users' sessions.
- *Impact:* a function's per-user authorization (`AUTH_USER`) is only as strong as the zone. It is
  not an independent check.
- *Mitigation today:* it is by design. The function authorizes on the zone's word, and the zone is
  the unit of trust (one Self-Contained System per zone).
- *Closes it:* a signed user assertion, such as the user's own token, forwarded and verified by the
  function against the identity provider.

**Related:** `.claude/rules/security.md` still describes this link as "shared signed token → mTLS via
mesh". That file is not an agent's to edit; the maintainer should update it to the per-zone EdDSA
design above, with mTLS as the closure of G1 and G2.

## 3. Cache-invalidate endpoint

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **S**poof / **E**lev. | Unauthenticated caller invalidates / clears the cache. | **Bearer `CACHE_INVALIDATE_TOKEN`, fail-closed** (`isAuthorized`); no `GET` variant so the token can't leak via URL/prefetch (#78). See `mutating-endpoints.md`. | — |
| **T**amper | Cache poisoning via crafted `revalidateTag`. | Token-gated; only declared tags revalidated. | — |
| **R**epudiate | No audit of who invalidated. | Request logging (pino). | Add caller identity to the log line. |
| **I**nfo disclosure | Token in logs/URLs. | Token in header only, never logged; `block-secrets.sh`. | — |
| **D**oS | Repeated invalidation thrashes Redis/origin. | Token-gated (not anonymous); reverse proxy rate-limits (security.md runtime hardening). | Confirm proxy limits in deploy guide. |

## 4. Supply chain

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **T**amper | Upstream re-pushes a base tag, changing the bytes we sign. | **All Dockerfile `FROM` lines digest-pinned** (`@sha256:`), enforced by `scripts/check-base-images-pinned.sh` (CI `base-image-pin-guard`). | Refresh digests on intentional bumps. |
| **T**amper | A malicious published image is deployed. | **cosign keyless sign + verify** on main for *both* the operator (`operator-supply-chain.yml`) and now the app (`supply-chain.yml` + `apps/file-manager/hack/cosign-verify.sh`); SBOM attestation. | Clients should `cosign verify` before deploy. |
| **I**nfo disclosure | Vulnerable deps shipped silently. | **syft SBOM** per image; **Trivy fails the build on HIGH/CRITICAL** on main (`--ignore-unfixed`) — and **both images are scanned BEFORE they are pushed** (`supply-chain.yml` + `operator-supply-chain.yml`: build local → SBOM → Trivy gate → push → sign; guarded by `tests/supply-chain-workflow.test.ts` + `tests/operator-supply-chain-workflow.test.ts`), so a scan-failed image is never pullable at a stable tag and never signed — and a scan-failed operator run never refreshes the `operator-latest` release's `install.yaml`. The Trivy/syft actions themselves are **SHA-pinned** in both workflows. Builder pinned to a patched Go release (`check-trivy-baseimage.bats.sh`). | — |
| **R**epudiate | Can't prove which source built an image. | **cosign SBOM attestation + keyless signature** for both images, plus **buildkit SLSA provenance (`mode=max`) restored for BOTH images**: each build exports an OCI layout (which, unlike the `docker` exporter used briefly after the scan-before-push fix, carries the attestation manifest), Trivy gates that exact layout, and a version+checksum-pinned `crane push` publishes it byte-for-byte; a post-push step **fails the run if the pushed index lacks the attestation manifest or the SLSA provenance predicate** (guarded by both workflow test files). | `mode=max` records build args — safe today (the only arg is the public `SOURCE_DATE_EPOCH`); never add a secret build-arg. |
| **Reproducibility** | Two builds of the same commit differ, weakening provenance. | **Not yet fully reproducible** — `SOURCE_DATE_EPOCH` (commit time) is now passed to the app build as a best-effort input, but pnpm/npm install ordering and native `sharp` prebuilts still vary. We deliberately do **not** claim reproducible builds. | Enable buildkit `rewrite-timestamp` + a lockfile-pinned, vendored install before claiming it. |
| **E**lev. of priv. | The `npm-publish` GitHub Environment has no protection rules, so a scheduled `release.yml` run on `main` publishes to npm with no reviewer click; no ruleset protects `v*` tags either. | Nightly drift detector (`npm-publish-drift-nightly.yml` / `scripts/lib/npm-publish-drift-check.mjs`, #1638 item 2) reads both settings back from the API and alerts when either is missing — see `npm-publish-drift-check.md`. | **Adding the reviewer + the ruleset is still open** (#1638 item 1, founder-only repo settings) — the detector is expected to be RED until then. |
| **T**amper | A malicious or hijacked package version is pulled in through a lockfile bump (the event-stream / ua-parser-js shape). | **OSV gate on every PR** (`osv-scan.yml`, `scripts/osv-gate.mjs`, policy in `scripts/lib/osv-gate.mjs`, pinned by `tests/osv-gate.test.ts`, mutation-proved by `scripts/mutation-prove-osv-gate.mjs`): OSV-Scanner over every tracked `bun.lock`, `Cargo.lock` and `go.mod`, failing on any `MAL-` (OpenSSF malicious-packages) advisory and on a NEW HIGH/CRITICAL vulnerability. The scanner binary is pinned by version and sha256. A finding that moves between lockfiles and a NEW unscored advisory also fail; allowlist entries are scoped to advisory, package, version and lockfile and must expire. **Fresh-release quarantine** is enforced on the RESULT as well as at install time: `release-age.yml` / `scripts/release-age-gate.mjs` check every added or altered lockfile entry (npm, crates.io, Go) against the registry's publish time and fail closed if the registry is unreachable; an unresolved source (git, tarball, another registry) fails unless a scoped exception names it, and a tarball re-pinned to new bytes under the same URL counts as a change because the integrity hash is part of the entry. The Go module proxy's recorded time can be backdated by a compromised maintainer, so for Go this is a delay on honest releases, not a defence against a malicious one (`tests/release-age-gate.test.ts`, `scripts/mutation-prove-release-age.mjs`). **Fresh-release quarantine**: `bunfig.toml` `install.minimumReleaseAge` (3 days) keeps bun from resolving a version the registry may yet pull; Dependabot's `cooldown` matches it (`tests/bun-release-age.test.ts`, `tests/dependabot-ecosystems.test.ts`). | The gate trusts OSV's coverage: a brand-new malicious version not yet reported passes, which is what the quarantine is for. Pre-existing HIGH advisories in the tree are reported, not blocking. `go.sum` is not scanned (no OSV extractor); `go.mod` carries the module graph. |
| **E**lev. of priv. | A dependency's install script runs code on a developer machine or CI runner. | Only a reviewed list may run one: root `trustedDependencies` is pinned to `security/bun-install-scripts.json`, and every lockfile package on bun's built-in default list must be named there (`tests/bun-install-scripts.test.ts`, mutation-proved by `scripts/mutation-prove-bun-install-scripts.mjs`). | **bun's default-trusted list is additive and cannot be turned off** (measured on bun 1.4.2), so `trustedDependencies` is not a deny-by-default switch; the guard pins the effective set instead. `esbuild` and `@bufbuild/buf` postinstall run today. |
| **I**nfo disclosure | An advisory is filed AFTER we shipped (a CVE on a dependency of a published tarball, or on a layer of a published image), so the publish-time gate that cleared it never sees it. | **Nightly re-scan of the registries** (`shipped-artifacts-nightly.yml`, `scripts/audit-shipped-npm.mjs`, `scripts/resolve-shipped-images.mjs`, pinned by `tests/shipped-scan.test.ts`, mutation-proved by `scripts/mutation-prove-shipped-artifacts.mjs`): every distinct version on every dist-tag of `@getknext/core` is installed from npmjs and checked with `npm audit`, OSV-Scanner and `npm audit signatures`; the digest-pinned operator image in the `operator-latest`, `operator-edge` and newest `operator-v*` bundles and the newest published app image get Trivy at HIGH,CRITICAL by digest; every tracked lockfile is re-checked for `MAL-` advisories. One create-or-update alert issue; no job-level `if`, no soft-fail flag, an `npm audit` error document or unreachable registry is a failure. | **The function template images are not published to any registry** (`go-template.yml` and `rust-template.yml` build, scan and discard), so there is nothing to re-scan; `tests/shipped-scan.test.ts` goes red the day a workflow starts publishing one. A shipped artifact cannot be patched in place: the nightly reports, a new release remediates. |

### The vinext build target: an image scan of a compiled binary is vacuous (ADR-0042 C6)

The opt-in vinext target is `bun build --compile --bytecode`: one executable with every JS
dependency inlined. syft and Trivy can read an image's Alpine package database out of it; they
cannot read anything out of the binary. So an image scan of a vinext image is green **because
there is nothing left in the image to scan** — the same vacuity ADR-0042 used to reject
`FROM scratch`, and full `resolve.noExternal` inlining completes it by deleting the last
externalised JS.

The mitigation is to scan the surface that still exists — the **pre-compile dependency closure**,
i.e. the resolved `node_modules` tree that feeds `vite build`:

- `scripts/precompile-closure-audit.mjs` generates a **CycloneDX SBOM (syft)** over the installed
  tree, verifies that the SBOM actually covers that tree, then runs **grype over that exact SBOM**
  and fails on **HIGH/CRITICAL** minus the dated + justified
  `security/precompile-closure-allowlist.json`.
- CI job `vinext-precompile-closure` runs it on every PR, uploads the SBOM as an artifact, and is
  `needs:`-before `bun-exec-alpine-image` — the only job that builds a vinext artifact today. No
  vinext image is published from CI yet; the ordering exists so the precondition holds the day one
  is, and `tests/precompile-closure-gate-ci.test.ts` *scans* **every `.github/workflows/*.yml`** for
  any job that builds the binary or its image — including one that compiles via the `bun run build`
  package-script alias for `./build.sh` — and requires a job running the closure audit in its
  transitive `needs` closure. It does **not** see a lane that compiles through a reusable workflow,
  a composite action or a shell wrapper; adding one means extending
  `tests/helpers/vinext-artifact-scan.ts` in the same change.

**What is still owed.** That scan guards **ordering only**. ADR-0042 C6 also requires the closure
SBOM to be **attached to the image as a cosign attestation** — the day a vinext publish lane ships,
the SBOM must be attached to the published image digest with cosign, because a `needs:` edge alone
would let an image publish with no SBOM bound to it. Today the SBOM is a per-run Actions artifact:
evidence of what was scanned, not provenance attached to an artifact.

**Scope.** The gate covers exactly one closure — the in-repo `examples/bun-exec`, which is the only
vinext application that exists today. A **user** application built on the vinext target has no
equivalent closure gate yet.

Two measured facts that shape the design, both of which make a naive setup **silently vacuous**:

- `syft scan dir:node_modules` with **default catalogers** yields **zero** npm components; the
  `+javascript-package-cataloger` selector is load-bearing.
- `trivy fs` over the example scans `bun.lock` and catalogues **60 npm packages**, where the same
  installed tree holds **210 packages** by the audit's own walker and yields **409 npm components**
  under syft (it counts nested copies and the `package.json` files inside published packages;
  `find -name package.json` returns 527). It missed a HIGH the tree carried. A lockfile is a claim
  about what should be installed; the installed tree is what the compiler swallows.

Hence the emptiness guard (`scripts/lib/precompile-closure.mjs`): floors on both the SBOM component
count and the on-disk package count (an empty tree has *perfect* coverage), a coverage ratio, and
named toolchain anchors. Mutation-proved by pointing it at an empty directory (exit 1) and at a
default-cataloger SBOM (0 components, red).

### `/app/native`: the one thing in a vinext image that is neither compiled in nor scanned

The closure audit above covers the JS the binary swallows. It does **not** cover `/app/native` —
sharp's `@img` addon plus libvips, ~18 MB of `.node` / `.so` that ships *beside* the executable
because a compiled binary cannot `dlopen` a path inside its own virtual filesystem. That tree is the
only remaining path from the install store to native-code privilege in the running pod, and an SBOM
would not close it anyway: a `.node` is an opaque blob, so an SBOM listing the *package* cannot tell
a swapped addon from the real one.

It is pinned instead, in two halves of deliberately different strength:

- **Provenance, at stage time.** `writeNativeIntegrityManifest`
  (`packages/kn-next/src/cli/native-integrity.ts`, called from `stageSharpNative` and from
  `apps/file-manager/Dockerfile` via `scripts/write-native-integrity.mjs`) requires every staged
  `@img` package to appear in `bun.lock` at exactly the version on disk. A missing entry or a
  version mismatch **fails the build** — an `@img` package the lockfile never resolved is the
  injected-dependency case, not a thing to skip. Stated precisely: bun records the integrity of the
  packed **tarball** and what ships is the **extracted tree**, so this pins *which package*, not
  *which bytes*.
- **Bytes, at load time.** The same step writes `native/.integrity.json` — sha256 per staged file —
  and the dlopen shim (`packages/kn-next/src/adapters/sharp-addon-dlopen.mjs`) re-hashes every
  native payload the manifest lists **before** calling `process.dlopen`. A mismatch, or a payload
  the manifest does not list, is fatal and names the file. libvips is covered too, not just the
  addon: the OS loader pulls it in transitively off a relative rpath, so it never passes through the
  shim and verifying only the dlopened file would leave the larger binary unpinned.

**Residual, stated rather than implied.** A manifest that is *absent* warns and loads — images built
before this landed have none, and failing closed on absence would turn a supply-chain fix into a
fleet outage. So an attacker who can strip a file from the image can also downgrade verification to
a warning. The template Dockerfile therefore fails the **build** when the manifest is missing, which
narrows the window to an image mutated after build; closing it fully needs the manifest bound to the
image digest by a signature, which is the same owed work as the closure SBOM attestation above.

That permissiveness is now a **dated exception with an off switch**, not an open-ended default.
Setting **`KNEXT_REQUIRE_NATIVE_INTEGRITY`** in the app's environment makes an absent manifest a
refusal — an operator who knows every image in their fleet postdates native-tree pinning can close
the downgrade path today, without waiting for the default to change. A *mismatch* stays fatal either
way.

The variable has three outcomes, and the third is the one to plan a rollout around:

| value | behaviour |
| --- | --- |
| `1`, `true`, `yes`, `on` (any case, surrounding whitespace ignored) | **fail closed** — an absent manifest refuses to `dlopen` |
| `0`, `false`, `no`, `off`, empty, or unset | the dated exception stands — an absent manifest warns and loads |
| anything else | **the process refuses to start** |

That last row is deliberate and worth stating plainly as an operational consequence: a value the
runtime cannot parse — `enabled`, `2`, a typo — is neither read as "on" nor as "off". Reading it as
"off" is the fail-open case an operator would never see (they would believe the fleet refuses an
unverifiable native tree while nothing had changed); reading it as "on" would brick a fleet on a
typo *silently*. So it throws, by name, listing the accepted values. On a pre-pinning image that
surfaces as a **crash loop on first `/_next/image` request** rather than a quiet misconfiguration —
loud, immediate, and fixed by correcting the variable. Set it from a reviewed manifest, not by hand
on a live workload. The check runs whether or not the image carries a manifest, so a bad value
cannot pass on one image and refuse on the next.

The exception's expiry and its re-raise condition live in
`scripts/lib/native-integrity-policy.mjs`, read by the shared dated-exemption reader; the clock reds
CI rather than the runtime, because a wall-clock branch inside the shim would brick running pods at
midnight on the expiry date — the same fleet outage the exception exists to avoid.

### Patching policy — `apk upgrade` on a digest-pinned base (#267)

Runner/runtime stages of every shipped alpine image run `apk upgrade --no-cache`
against a digest-pinned base (precedent: the `apps/file-manager/Dockerfile` runner stage,
added in #267). This is not a pinning violation, and `scripts/check-base-images-pinned.sh`
deliberately does not flag it — its scope is `FROM` lines only (the base *input*), not
packages resolved at build time.

- **Whole base, not a named list (#971).** The idiom is a **whole-base** `apk upgrade
  --no-cache` before the `apk add` of the runtime's link libs — NOT `apk add --upgrade
  <named packages>`. A named list only patches the packages someone thought to enumerate
  (libstdc++/libgcc/libcrypto3/libssl3), so the next base-layer HIGH in busybox/zlib/
  apk-tools/ssl_client recurs and needs a bespoke PR; the whole-base upgrade patches every
  base package to the branch's current version at once. Package **versions are deliberately
  not pinned** — a pinned version goes stale like the digest and hard-fails the day the branch
  drops it. Enforced across the shipped alpine surface by `tests/base-image-cve-hygiene.test.ts`,
  which scans (not enumerates) so a newly added alpine Dockerfile without the idiom fails.
- **The base digest pins provenance of the input.** `apk upgrade` pulls only fixes already
  published on the **same pinned alpine stable branch** — it cannot float the base to a
  different alpine release.
- **The trust anchor for what SHIPPED is the scanned + signed OUTPUT digest.** Both
  supply-chain workflows (`supply-chain.yml`, `operator-supply-chain.yml`) Trivy-gate the
  exact built image (fail on HIGH/CRITICAL) **before** any push, and cosign-sign the pushed
  digest on `main` — a scan-failed image is never pullable at a stable tag and never signed.
  PR builds are Trivy-scanned too (report-only — the gate enforces on `main`), and never
  pushed or signed.
- **The two previously-unscanned shipped alpine bases are now Trivy-scanned (#971).**
  `apps/docs/Dockerfile`'s runtime (`oven/bun:*-alpine`) and
  `examples/bun-exec/Dockerfile.node` (`node:22-alpine`) had no image-layer Trivy gate. The
  `base-image-trivy` matrix in `supply-chain.yml` now scans each pinned base reference
  (HIGH/CRITICAL, `--ignore-unfixed`, report on PRs / enforce on `main`). A failure there is
  the signal to bump the pinned digest — the durable maintenance loop, not a reason to unpin.
- **Digests are still refreshed on intentional bumps.** The in-place upgrade only covers the
  window between a published apk fix and the next digest bump (e.g. c-ares 1.34.8-r0 for
  CVE-2026-33630); it is a complement to digest pinning, not a substitute.

## 5. Metrics scrape (Prometheus → operator)

The operator exposes controller-runtime metrics over HTTPS. By default the metrics server presents a
**self-signed certificate** (auto-generated by controller-runtime — `cmd/main.go`), so the shipped
`ServiceMonitor` scrapes with `insecureSkipVerify: true` (`config/prometheus/monitor.yaml`). The
endpoint requires authn/authz (`WithAuthenticationAndAuthorization` filter, `cmd/main.go:152`).

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **S**poof | A rogue in-cluster endpoint impersonates the metrics server. | Targets are label-selected on the operator's own Service; the scrape is cluster-local (no ingress). | `insecureSkipVerify` means the server's identity is **not** verified — an in-cluster MITM on the pod network could impersonate it. Closed by the cert-manager path below. |
| **I**nfo disclosure | The scrape's SA bearer token is harvested by a MITM. | Metrics are non-sensitive counters; the scrape stays on the cluster-local pod network. | The bearer token authenticates *Prometheus → endpoint*; with skip-verify it does **not** verify the endpoint back to Prometheus, so a MITM could capture the token. Enable cert-manager + `monitor_tls_patch.yaml` (references the `metrics-server-cert` secret) for verified TLS. |
| **T**amper | Scraped metrics altered in transit, corrupting dashboards/alerts. | HTTPS encrypts the channel against passive tampering. | Verified TLS (cert-manager patch) closes active MITM. |
| **D**oS | Anonymous scrapes exhaust the operator. | The endpoint requires **authn/authz** (`WithAuthenticationAndAuthorization`) — anonymous scrapes are rejected. | — |

**Decision:** `insecureSkipVerify: true` is accepted for the **default install** — the endpoint is
cluster-local and read-only, the scrape is authenticated, and metrics carry no secrets. The residual
in-cluster-MITM / token-harvest risk (the same trade-off as the upstream kubebuilder default) is
closed by enabling cert-manager and the `monitor_tls_patch.yaml` patch (see
`config/prometheus/kustomization.yaml`), which references the `metrics-server-cert` secret instead of
skipping verification.

---

## 6. Request ingress to an app pod (ADR-0044)

Two paths reach a knext app, and they are bounded differently. **External**: LoadBalancer → Kourier
(Envoy) → activator/queue-proxy → app container — three HTTP parsers, `containerConcurrency`
enforced. **In-cluster**: a co-resident pod dialling the app pod directly. Until ADR-0044 the second
path was **unbounded** — the default NetworkPolicy carried no port restriction and an empty
same-namespace `PodSelector`, so a neighbour pod reached the app container's port directly, skipping
queue-proxy and with it the concurrency bound and the Go parser.

ADR-0044 Option E closed the *path*: the policy now admits only the queue-proxy ports
(8012/8013/8112) and metrics ports (9090/9464) from `knative-serving`/`kourier-system`, and metrics
ports only from the same namespace. **It does not cap bytes** — that is Option C, which has
shipped: ADR-0044 Amendment 4 (vinext build) and Amendment 6 (standalone build, node and bun,
compiled or not) cap every request body in-process at `KNEXT_MAX_REQUEST_BYTES` (default 8 MiB).

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **D**oS (vertical) | One request whose body a route handler buffers (`await req.json()`) exhausts the pod's memory. | In-process request-body cap on every build (ADR-0044 Option C, Amendments 4 + 6): `KNEXT_MAX_REQUEST_BYTES`, default 8 MiB, counted bytes (chunked bodies included), `413` before the handler sees an oversized body. `serverActions.bodySizeLimit` caps **Server Actions** at 1 MB; `spec.timeoutSeconds` (default 300s) bounds how long one request holds a slot. | **MITIGATED, with a bound, not eliminated.** Worst case is now cc × cap buffered bodies (20 × 8 MiB = 160 MiB against a 1Gi limit). Residual: an operator who sets `KNEXT_MAX_REQUEST_BYTES=0`, or a cap × cc above the memory limit, re-opens it (logged at boot). |
| **D**oS (drain bypass) | Repeated OOM degrades availability beyond the individual request. | — | **OPEN, and worse than it looks.** OOMKill is **SIGKILL**: it bypasses the SIGTERM path entirely, so in-flight drain, Next `after()`, and `registerDbPoolDrain` are all skipped. Leaked connections then eat the ADR-0028 `maxScale × poolMax ≤ 80` budget while the restarted pod opens a fresh pool, and each restart pays a full cold start. **No test exercises this path** — the drain gate only covers SIGTERM, so the connection-leak consequence is currently unobservable. |
| **D**oS (rate) | A client floods the app; KPA scales out and bills the tenant. | Bounded by `maxScale` (default 10) × pod memory — a worked ceiling, not an absence. | **OPEN.** No per-client rate limiting anywhere. Mitigate with a front proxy (see the user-facing recipe); note that proxy rate-limit counters are **per replica** unless the proxy shares state. |
| **E**levation / lateral | A co-resident pod (including another zone) reaches the app container directly, bypassing queue-proxy — and, per `scs-zones.md`, calls another zone synchronously when the contract permits only the browser and async events. | ADR-0044 Option E: port allowlist + same-namespace peer scoped to metrics only. Proved by the kind+Calico enforcement drill (direct dial refused, metrics survive, and the refusal disappears when the policy is deleted). | **CNI-conditional.** flannel — which OKE GA and OrbStack run — ships **no NetworkPolicy controller**, so on those clusters the object is declarative-only and enforces nothing. Enforcement requires Calico/Cilium. |
| **S**poof / **T**amper | Malformed HTTP reaches app code. | Three real parsers on the external path (Envoy, Go `net/http`, Node `llhttp`); Node's 16 KB header cap on both paths. | On the in-cluster path only `llhttp` stands in front of app code. |

**Cross-namespace metric scraping (#735).** The default policy admits only
`knative-serving`, `kourier-system` and the app's own namespace, while the operator ships a
`PodMonitor` with `namespaceSelector: any` — so on a policy-enforcing CNI the operator's own scrape
was denied, and the tests asserted *same-namespace* scraping and would have stayed green forever.
Closed by a third ingress rule admitting namespaces labelled `knext.dev/metrics-scrape=true` on the
**app metrics port only** (`9464` — deliberately narrower than the same-namespace rule, since the
shipped PodMonitor targets nothing else). A cluster that labels nothing keeps the prior posture
exactly, and a labelled namespace never reaches the serving ports.

**Residual, stated rather than implied:** this is **namespace RBAC, not a per-app privilege
boundary**. The label sits on a cluster-scoped Namespace, so the grantor is whoever holds
`update namespaces` — on a platform with self-service namespaces, a tenant can grant itself. Once
labelled, *every* pod in that namespace (not just Prometheus) can scrape `9464` on *every* knext app,
which in a shared cluster is cross-tenant metric disclosure. **What is actually exposed, enumerated
from the exporter rather than assumed** — and since ADR-0048 that exporter is the compiled
executable's own exposition (`templates/app/runtime-contract.mjs.hbs`), **not** the retired node
supervisor's prom-client registry (`adapters/metrics.ts`), which no longer serves this port:

<!-- The "9091" in this anchor id is HISTORICAL — the app metrics port moved to 9464 (#951:
     queue-proxy owns :9091 on a stock serving install). The id is pinned by
     observability-metric-contract.test.ts and scripts/mutation-prove-metric-contract.mjs;
     renaming it is a three-file change with no informational payoff. -->
<!-- metric-contract:9091-disclosure start -->

- **Seven series families, and no more.** `knext_bunexec_http_requests_total`,
  `knext_bunexec_http_request_duration_seconds`, `knext_bunexec_http_inflight_requests`,
  `knext_bunexec_startup_duration_seconds`, `knext_bunexec_process_resident_memory_bytes`,
  `knext_bunexec_process_uptime_seconds`, and `knext_deep_health_state`. The list is pinned against the
  emitter by `observability-metric-contract.test.ts`, so it cannot drift from what the binary serves.
- **The seventh, `knext_deep_health_state`, is forwarded from the app's own registry** by the runtime
  contract's allowlist (`APP_METRIC_FAMILIES`), and is served with tracing on or off, present only while the app has used its database within the activity budget (45 s by default; an idle app serves no such series). It carries
  `app`, `dependency` (`overall`, `postgres`, `redis`) and `state` (`ok`, `degraded`, `down`, `waking`,
  `up`, `unconfigured`) — twelve fixed series per pod, no host names, connection strings or error text.
  It discloses whether an app's database or cache is currently up. The forward is an allowlist of exactly
  that one family: the rest of the app registry (its request-rate series, which do carry a `method` label,
  and the cold-start and DB-wake families) is **not** forwarded, and a test fails if the allowlist grows without
  this list growing with it.
- **No route, path, query, payload — or even method — labels.** The request counter carries
  `status_class` alone, five fixed values; the duration histogram carries none. Individual status
  codes do not leak either. An earlier version of this section claimed route labels leak, and a
  later one claimed `app` and `method` labels; both were wrong, and overstating a risk erodes the
  document as surely as understating one.
- **Request volume and error ratio for the pod**, by status class only.
- **Restart and scale-to-zero timing**, from `knext_bunexec_process_uptime_seconds` and
  `knext_bunexec_startup_duration_seconds` — per-app traffic patterns can be inferred from these.
- **Resident memory**, a coarse load signal.

<!-- metric-contract:9091-disclosure end -->

**On the standalone server with CDN mode on** (`spec.cdn`; the vinext binary above has no CDN
support), the same port also carries three CDN counters: `knext_cdn_edge_decision_total`
(`result`, `reason`), `knext_cdn_foreign_edge_strip_total` (no labels) and `knext_cdn_purge_total`
(`provider`, `result`). Every label is a closed set of values; none carries a path, URL, cache tag
or token. They disclose how much of an app's traffic is edge-cacheable and why not, and how its
purges fare. Without `spec.cdn` they do not exist.

**On the standalone server with the `'use cache'` store wired** (Next with `cacheHandlers`, set by
the knext build; the vinext binary above has its own cache adapter), the same port also carries
`knext_use_cache_events_total` (`event`). The label is a closed set of fourteen values; none carries
a cache key, tag, path or argument. It discloses the app's `'use cache'` hit ratio, write volume,
oversize entries and Redis outages as seen by the cache.

**On the standalone server of an app that opts into in-process Rust** (`knext.ffi.json`; the
generated module publishes the seam on its first call), the same port also carries
`knext_ffi_slow_calls_total` (`fn`) and `knext_ffi_load_seconds` (`lib`). The labels are a closed
set: the Rust export names and the library name from the library's embedded manifest, never an
argument or a request value. They disclose which Rust functions the app exports, how often each
one blocked the process past the threshold, and how long the library took to load. Without the
opt-in they do not exist.

**What is NOT on this port, contrary to earlier versions of this section:** cold-start and DB-wake
series, the rest of the app's request-metric registry, and the `nodejs_*`/`process_*` families `collectDefaultMetrics` registers. Those
are prom-client metrics on an app's own `/api/metrics` route, which the shipped PodMonitor does not
scrape — an app that publishes that route publishes them itself, and that is the app's decision to
make, not this port's exposure.

`:9464` serves `GET /metrics` and nothing else — no pprof, health or debug endpoints — so the
exposure is bounded to the above. There is no `PodSelector` because the operator cannot know a user's
Prometheus labels. Operators needing workload-level identity **cannot** fix this by adding a policy alongside:
NetworkPolicies are additive, so a second policy unions its allow-rules with knext's rather than
narrowing them. The only lever is `spec.security.networkPolicy: false` — which disables knext's
policy entirely — followed by a bring-your-own policy that expresses the tighter grant.

**Two operability gaps, named rather than discovered later.** A *mistyped* label value fails
silently — scraping is simply denied, with nothing telling the operator why — and an app owner has
no signal that their app *is* being scraped from another namespace: no status condition, no event,
no metric. Both are observability gaps rather than isolation gaps, but they mean the grant's state
is invisible from both sides. **Revocation** works for new connections (asserted by the enforcement
drill's step 2e); established keep-alive connections can survive unlabelling until torn down,
because CNIs evaluate policy at connection setup and keep flows in conntrack.

**Decision (dated exception, opened 2026-08-15).** knext does **not** yet ship in-process payload or
rate protection. Options D+E close what can be closed without touching the runtime; the byte-cap
remainder is a **bounded, dated exception** in the shape of ADR-0015 — re-reviewed at every sprint
close, with a hard expiry at **Tier-A exit or v1.0**, whichever comes first. This is recorded as an
exception, not as compliance with `security.md`'s reverse-proxy requirement.

---

## Out of scope (and why)
- **Global edge / WAF / DDoS at the CDN layer** — architectural edge knext does not own
  (CLAUDE.md §8); upstream-gated.
- **App business-logic vulns** in customer code — knext secures the *platform* surface, not the
  tenant's application logic.
- **Cross-zone data sovereignty** — covered by `scs-zones.md` + `protect-zone-data-sovereignty.sh`,
  not re-litigated here.
