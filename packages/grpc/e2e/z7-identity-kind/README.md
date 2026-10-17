# Z7 identity tokens on kind

An end-to-end run of a zone's identity tokens on a real cluster: the operator built
from this checkout, a zone bound to a Go and a Rust function, and calls made by the
zone's generated glue through the real signer. CI runs it as
`.github/workflows/z7-identity-kind-e2e.yml`; you can run the same script against a
kind cluster of your own:

```bash
packages/grpc/e2e/z7-identity-kind/run.sh          # all phases: about 12 minutes on a GitHub-hosted runner
PHASES="deploy verify" Z7_WITH_RUST=0 packages/grpc/e2e/z7-identity-kind/run.sh
```

Needs `docker`, `kind`, `kubectl`, `jq`, `go`, `bun` and `node` on the PATH. The first local run is longer
(it builds the operator and the images); against a cluster that already has them, `PHASES="deploy verify rotate leaks"`
is about 15 minutes, most of it waiting for the kubelet.

| Phase | What it does and proves |
| --- | --- |
| `up` | Creates the kind cluster (default `knext-z7-e2e`) and a local registry, installs cert-manager, Knative Serving and Kourier, then builds and installs the operator with the operator's shipped propagation bound (it reads the number from the operator's contract fixture, so the lane follows the default). |
| `images` | Builds and pushes the Go function, the Rust function and the zone to the local registry. The operator requires digests, so every image is referenced by one. |
| `deploy` | Recreates the namespace and applies the zone (`NextApp`) and its functions (`BackendService`), all at minScale 1 so a rotation meets warm pods. |
| `verify` | The key Secret and JWKS exist and are owned by the zone; a generated query and Server Action reach the Go function with a real token; each wrong token (none, garbage, another key, a forged kid, another function, another RPC, expired, another issuer, an empty sub on an AUTH_USER RPC, a life of 61 s) is refused next to a control that differs in that one property; the function pod holds no private key and mounts the JWKS as a directory volume. |
| `rotate` | Rotation by annotation: the new key is published beside the old, a warm function accepts a token signed by it before the switch, signing switches only after the bound, the zone's signer picks the new key up without a restart, the previous key keeps verifying through the overlap, no call through the zone fails, and retirement removes the old key and makes a warm function refuse it. |
| `leaks` | No key material in the logs of every operator pod (including the ones the rotation's restart replaces), the pods' logs, the events or the published objects, in every shape the operator itself redacts: the PEM's body lines, and the PEM, the 32-byte seed and the 64-byte private key each in the four base64 encodings (`key-needles.ts`). |

The script never deletes a cluster. It deletes only the namespace it created (it
stamps it with a label and refuses a namespace without one), and it reads Secrets only
into files in a private temporary directory, never to the terminal.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIND_CLUSTER` | `knext-z7-e2e` | Cluster name; created if missing, kept afterwards. |
| `REGISTRY_NAME` / `REGISTRY_PORT` | `knext-z7-registry` / `5001` | The local image registry. |
| `Z7_NAMESPACE` | `z7-e2e` | Namespace for the zone and its functions. |
| `Z7_PROPAGATION_BOUND` | unset | Set it (whole seconds, for example `150s`) to run the operator with `--zone-signing-key-propagation-bound`. Unset, the operator runs without the flag, so the lane tests the shipped default; the lane reads that value and the minimum from the operator's contract fixture. |
| `Z7_WITH_RUST` | `1` | `0` skips building and binding the Rust function. |
| `PHASES` | all | A subset of the phases above, in any combination. |

## Mutation proof

`scripts/mutation-prove-2461-z7-kind-e2e.mjs` proves the lane is not decoration, in two
halves.

- Always (no cluster, part of the nightly prover sweep): it breaks one property of the
  probe's tokens, one class of the leak-scan needles, or one rule of the workflow, path
  filter or script, at a time, and requires the three cluster-free guards to go red.
- By hand: `mutation-prove-operator.sh` breaks one rule in the **operator** at a time (the
  propagation bound is not waited, the staged key is not published, the previous key is
  retired at once, the staged key reaches the zone's pod, a function mounts the JWKS through
  a subPath, the operator logs the key as a string, as the base64 a Secret holds, or as a
  JWK `d`; and the lane's own rotation watcher dies after three rounds; the rows are in
  `mutation-rows.mjs`), builds that operator, rolls it out, and requires `run.sh` to go red
  and to name that reason. It then
  runs the unmutated operator through every phase, which must pass. It needs a cluster that
  has had `PHASES="up images"` and takes about an hour. Its anchors are checked without a
  cluster by `tests/z7-identity-kind-e2e-lane.test.ts`.

## What it does not prove

- The overlap is a one-hour constant in the operator. Retirement backdates the
  Secret's switched-at stamp and restarts the operator, which re-derives its state
  from the Secret; the elapsed-time logic is covered by the operator's unit tests.
- NetworkPolicy enforcement needs a policy-capable CNI. That is
  `packages/kn-next-operator/test/networkpolicy-enforcement-drill.sh`.
- The zone is a small Node server in front of the real generated glue, not a built
  Next.js app: `use cache` is not active here, but the signer, the transport and the
  generated authorize, version and error handling are the real ones.
- A signed operator release on OKE is a separate, later run.

## Files

- `run.sh`: the lane.
- `key-needles.ts`: the strings a leak of a key would contain, one 0600 file per class, never printed.
- `probe.ts`, `probe-lib.ts`: one Connect call to a function with a chosen token (`--auth raw` hand-builds the two tokens the real signer will not mint, an empty sub and a long life);
  unit-tested in `packages/grpc/src/__tests__/z7-e2e-probe.test.ts`.
- `mutation-prove-operator.sh`, `mutation-rows.mjs`: the operator half of the mutation proof.
- `zone-caller/`: the zone's image context (`build.ts` runs the real generator over the
  Go template's contract and bundles the glue with the real runtime).
