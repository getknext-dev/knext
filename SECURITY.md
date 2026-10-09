# Security policy

## Reporting a vulnerability

**Report privately through GitHub Security Advisories — do not open a public issue.** A public
issue or discussion is visible to everyone before a fix ships; a private advisory is not.

1. Go to the repository's **Security** tab → **Report a vulnerability** (this opens a draft GitHub
   Security Advisory, visible only to maintainers and you).
2. Include what you'd include in any good bug report: the affected component (CLI, operator, a
   published `@getknext/*` package, or a generated app artifact), the version, reproduction steps,
   and the impact as you understand it.
3. A maintainer will acknowledge the report and coordinate a fix and a disclosure timeline with
   you through the advisory thread. Coordinated disclosure means the advisory stays private until a
   fix is available, then is published (optionally with a CVE) crediting you unless you ask
   otherwise.

If GitHub Security Advisories are unavailable to you for some reason, do not fall back to a public
issue — that defeats the point. Wait, or escalate through whatever private channel you already
have with a maintainer.

## Supported versions

The **`1.x`** major line receives fixes, including security fixes, and they land on the **newest**
published `1.x` release on the npm `@getknext/*` scope. There is **no long-term-support branch**:
an older `1.x` minor stays installable, with no promise of backported fixes. Report against the
version you are actually running; if it predates the newest `1.x` release, the first response will
usually be "upgrade and confirm." The `1.0.0-rc.*` release candidates are superseded by `1.0.0` and
receive no further fixes, and neither does the `0.x` line.

**From the day `@getknext/core` 2.0 is generally available**, the `2.x` line is the supported one
and the final `1.x` minor moves to **security fixes only, for six months**, on a `release/1.x`
branch published under the `latest-1` dist-tag. After the six months it receives nothing. Until 2.0
is generally available this paragraph promises nothing beyond the one above. The full lane model is
in [`docs/RELEASE_POLICY.md`](docs/RELEASE_POLICY.md#support-window).

## Scope

This policy covers the code in this repository: the `@getknext/core`, `@getknext/lib` and
`@getknext/db` npm packages, the `knext`/`kn-next` CLI, and the Go operator
(`packages/kn-next-operator`). It does not cover:

- Vulnerabilities in a knext app's **own** code or dependencies — report those to the app's
  maintainers.
- Vulnerabilities in the Kubernetes distribution, Knative Serving, cert-manager, or any other
  cluster component knext runs on top of — report those upstream.
- Findings that require deployment-time misconfiguration that this project explicitly documents as
  the operator's responsibility to set correctly (for example, running a CNI with no
  `NetworkPolicy` support and then relying on network isolation — see
  [the docs security page](https://knext-platform.dev/docs/security#network-isolation) for what is and is
  not enforced automatically).
