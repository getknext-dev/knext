# kn-next-operator

The knext control plane: a Go/Kubebuilder controller that reconciles `NextApp`
custom resources into Knative scale-to-zero Services. Per ADR-0001 the operator is
the **single source of truth** for cluster state — the CLI emits a `NextApp` CR and
the operator reconciles it.

## Install (one command)

The operator image is built, SBOM'd, Trivy-scanned (fail on HIGH/CRITICAL),
cosign-signed, and pushed to `ghcr.io/getknext-dev/kn-next-operator` by
[`.github/workflows/operator-supply-chain.yml`](../../.github/workflows/operator-supply-chain.yml).
Each `main` build also publishes a digest-pinned `install.yaml` bundle (CRDs + RBAC +
manager Deployment + webhook + cert-manager resources + the Knative `config-network`
ConfigMap that sets the Kourier ingress-class — issue #45 / ADR-0009 — and the
`config-features` ConfigMap that enables the PVC PodSpec flags for the bytecode-cache
ksvc — issue #59 / ADR-0010).

Install knext's control plane with a single apply:

```sh
kubectl apply --server-side -f https://github.com/getknext-dev/knext/releases/latest/download/install.yaml
```

> Use `--server-side` so the bundle's `config-network` **and** `config-features`
> ConfigMaps **merge** into the ones Knative Serving already owns (which hold other
> networking / feature keys) instead of clobbering them.
>
> The bundle's manager image is **digest-pinned** (`@sha256:…`); it never uses
> `:latest` (enforced by `hack/check-no-latest.sh`).
>
> Prerequisites:
> - [cert-manager](https://cert-manager.io) must be installed in the cluster (the
>   bundle includes the operator's `Issuer`/`Certificate` for its webhook).
> - **Knative Serving + Kourier** must be installed. The bundle ships a
>   `config-network` ConfigMap (`namespace: knative-serving`) that pins
>   `ingress-class: kourier.ingress.networking.knative.dev` — the full
>   controller-qualified form. Without it, Serving leaves the ingress-class unset and
>   never wires routes to Kourier (this was the real cause of the OKE "Kourier broken
>   on k8s 1.34" symptom — see ADR-0009).
> - **PVC feature flags** (prerequisite for `spec.enableBytecodeCache`): the bundle
>   ships a `config-features` ConfigMap (`namespace: knative-serving`) enabling
>   `kubernetes.podspec-persistent-volume-claim` and
>   `kubernetes.podspec-persistent-volume-write` (both default-off). The bytecode-cache
>   ksvc mounts a **writable** PVC; without both flags Knative's admission webhook
>   denies the ksvc and reconcile fails — see ADR-0010. Unlike the ingress-class, these
>   flags are networking-layer-independent (safe under net-istio and kourier). A
>   `StorageClass`/provisioner is still required to bind the PVC (kind ships
>   `local-path`).

### Verify the signature (optional)

```sh
cosign verify ghcr.io/getknext-dev/kn-next-operator@sha256:<digest> \
  --certificate-identity-regexp 'https://github.com/getknext-dev/knext/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Description
The operator watches `NextApp` resources and provisions the corresponding Knative
Service, networking, and cache wiring. See `docs/adr/0001-*` for the control-plane
contract.

## Getting Started

### Prerequisites
- go version v1.24.6+
- docker version 17.03+.
- kubectl version v1.11.3+.
- Access to a Kubernetes v1.11.3+ cluster.

### To Deploy on the cluster
**Build and push your image to the location specified by `IMG`:**

```sh
make docker-build docker-push IMG=<some-registry>/kn-next-operator:tag
```

**NOTE:** This image ought to be published in the personal registry you specified.
And it is required to have access to pull the image from the working environment.
Make sure you have the proper permission to the registry if the above commands don’t work.

**Install the CRDs into the cluster:**

```sh
make install
```

**Deploy the Manager to the cluster with the image specified by `IMG`:**

```sh
make deploy IMG=<some-registry>/kn-next-operator:tag
```

> **NOTE**: If you encounter RBAC errors, you may need to grant yourself cluster-admin
privileges or be logged in as admin.

**Create instances of your solution**
You can apply the samples (examples) from the config/sample:

```sh
kubectl apply -k config/samples/
```

>**NOTE**: Ensure that the samples has default values to test it out.

### To Uninstall
**Delete the instances (CRs) from the cluster:**

```sh
kubectl delete -k config/samples/
```

**Delete the APIs(CRDs) from the cluster:**

```sh
make uninstall
```

**UnDeploy the controller from the cluster:**

```sh
make undeploy
```

## Project Distribution

Following the options to release and provide this solution to the users.

### By providing a bundle with all YAML files

1. Build the installer for the image built and published in the registry:

```sh
make build-installer IMG=<some-registry>/kn-next-operator:tag
```

**NOTE:** The makefile target mentioned above generates an 'install.yaml'
file in the dist directory. This file contains all the resources built
with Kustomize, which are necessary to install this project without its
dependencies. CI (`operator-supply-chain.yml`) runs `make build-installer`
after pushing the signed image and substitutes the **real published digest**
into `dist/install.yaml` before uploading it as the release bundle. The
checked-in `dist/install.yaml` carries a clearly-fake all-zeros bootstrap
digest until the first `main` push (see issue #76).

2. Using the installer

Users can just run 'kubectl apply -f <URL for YAML BUNDLE>' to install
the project, i.e.:

```sh
kubectl apply -f https://github.com/getknext-dev/knext/releases/latest/download/install.yaml
```

### By providing a Helm Chart

1. Build the chart using the optional helm plugin

```sh
kubebuilder edit --plugins=helm/v2-alpha
```

2. See that a chart was generated under 'dist/chart', and users
can obtain this solution from there.

**NOTE:** If you change the project, you need to update the Helm Chart
using the same command above to sync the latest changes. Furthermore,
if you create webhooks, you need to use the above command with
the '--force' flag and manually ensure that any custom configuration
previously added to 'dist/chart/values.yaml' or 'dist/chart/manager/manager.yaml'
is manually re-applied afterwards.

## Contributing
// TODO(user): Add detailed information on how you would like others to contribute to this project

**NOTE:** Run `make help` for more information on all potential `make` targets

More information can be found via the [Kubebuilder Documentation](https://book.kubebuilder.io/introduction.html)

## License

Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

