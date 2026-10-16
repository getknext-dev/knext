# Z7 identity tokens on kind

An end-to-end run of a zone's identity tokens on a real cluster: the operator built
from this checkout, a zone bound to a Go and a Rust function, and calls made by the
zone's generated glue through the real signer. CI runs it as
`.github/workflows/z7-identity-kind-e2e.yml`; you can run the same script against a
kind cluster of your own:

```bash
packages/grpc/e2e/z7-identity-kind/run.sh          # all phases: 30 to 40 minutes from nothing, about 15 once the cluster and images exist
PHASES="deploy verify" Z7_WITH_RUST=0 packages/grpc/e2e/z7-identity-kind/run.sh
```

Needs `docker`, `kind`, `kubectl`, `jq`, `go`, `bun` and `node` on the PATH.

| Phase | What it does and proves |
| --- | --- |
| `up` | Creates the kind cluster (default `knext-z7-e2e`) and a local registry, installs cert-manager, Knative Serving and Kourier, then builds and installs the operator with a 90 s propagation bound. |
| `images` | Builds and pushes the Go function, the Rust function and the zone to the local registry. The operator requires digests, so every image is referenced by one. |
| `deploy` | Recreates the namespace and applies the zone (`NextApp`) and its functions (`BackendService`), all at minScale 1 so a rotation meets warm pods. |
| `verify` | The key Secret and JWKS exist and are owned by the zone; a generated query and Server Action reach the Go function with a real token; each wrong token (none, garbage, another key, a forged kid, another function, another RPC, expired, another issuer) is refused next to a control that differs in that one property; the function pod holds no private key and mounts the JWKS as a directory volume. |
| `rotate` | Rotation by annotation: the new key is published beside the old, a warm function accepts a token signed by it before the switch, signing switches only after the bound, the zone's signer picks the new key up without a restart, the previous key keeps verifying through the overlap, no call through the zone fails, and retirement removes the old key and makes a warm function refuse it. |
| `leaks` | No key material in the operator's or pods' logs, the events, or the published objects. |

The script never deletes a cluster. It deletes only the namespace it created (it
stamps it with a label and refuses a namespace without one), and it reads Secrets only
into files in a private temporary directory, never to the terminal.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIND_CLUSTER` | `knext-z7-e2e` | Cluster name; created if missing, kept afterwards. |
| `REGISTRY_NAME` / `REGISTRY_PORT` | `knext-z7-registry` / `5001` | The local image registry. |
| `Z7_NAMESPACE` | `z7-e2e` | Namespace for the zone and its functions. |
| `Z7_PROPAGATION_BOUND` | `90s` | The operator's `--zone-signing-key-propagation-bound`. The minimum is 60 s. |
| `Z7_WITH_RUST` | `1` | `0` skips building and binding the Rust function. |
| `PHASES` | all | A subset of the phases above, in any combination. |

## Mutation proof

`mutation-prove.mjs` breaks one operator rule at a time (the propagation bound is not
waited, the staged key is not published, the previous key is retired at once, the staged
key reaches the zone's pod, a function mounts the JWKS through a subPath, the operator logs
a key), builds that operator, and expects the lane to go red for that reason. It then runs
the unmutated operator through every phase, which must pass. It needs a cluster that has
had `PHASES="up images"` and takes about an hour, so it is run by hand; its anchors are
checked without a cluster by `tests/z7-identity-kind-e2e-lane.test.ts`.

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
- `probe.ts`, `probe-lib.ts`: one Connect call to a function with a chosen token;
  unit-tested in `packages/grpc/src/__tests__/z7-e2e-probe.test.ts`.
- `zone-caller/`: the zone's image context (`build.ts` runs the real generator over the
  Go template's contract and bundles the glue with the real runtime).
