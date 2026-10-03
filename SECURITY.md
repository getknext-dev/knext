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

knext has not reached a `1.0.0` release. Pre-1.0, there is **no long-term-support branch**. Two
prerelease lines on the npm `@getknext/*` scope receive fixes, including security fixes: the latest
published `1.0.0-rc.*` (npm dist-tag `rc`) and the latest published `1.3.0-rc.*` (npm dist-tag
`next`). Report against the version you are actually running; if it predates the current release
candidate on its line, the first response will usually be "upgrade and confirm."

Once `1.0.0` ships, this section will name which major version lines receive security fixes.

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
