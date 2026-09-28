/**
 * The repository/CI secrets ADR-0049 stage 1 asks for, with the reason each
 * is needed — shared by every `init-ci` provider template (#1534).
 *
 * Split out of `init-ci.ts` so a provider-specific renderer (`init-ci-gitlab.ts`)
 * can read this list without importing `init-ci.ts` itself, which would create
 * a circular import (`init-ci.ts` needs the provider renderer to pick a
 * template by `--provider`). One list, several renderers.
 */

/**
 * A user who cannot see why a permission is wanted cannot consent to it, so
 * the reasons ship in every generated CI file rather than only in a docs page.
 */
export const REQUIRED_SECRETS = [
    {
        name: "KNEXT_KUBECONFIG",
        what: "base64 kubeconfig for the ServiceAccount created by knext-ci-rbac.yaml",
        why: "so the workflow can write the NextApp resource — nothing else",
    },
    {
        name: "KNEXT_NAMESPACE",
        what: "the namespace to deploy into",
        why: "keeps the credential's blast radius to one namespace",
    },
    {
        name: "KNEXT_REGISTRY",
        what: "registry host + namespace, e.g. ghcr.io/acme (the app name is appended)",
        why: "where the built image is pushed; you own it, knext never sees it",
    },
    {
        name: "KNEXT_REGISTRY_TOKEN",
        what: "a push token for that registry",
        why: "as above — omit on GHCR, where the built-in GITHUB_TOKEN suffices",
    },
] as const;
