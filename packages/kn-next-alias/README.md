# kn-next

The bare-name alias for [`@getknext/core`](https://www.npmjs.com/package/@getknext/core) — the
scale-to-zero Next.js deployment CLI for Knative/Kubernetes.

This package exists so the obvious command works:

```bash
npx kn-next --help
```

All functionality lives in `@getknext/core`; this package only forwards to its CLI with the same
arguments and exit codes. Install either one — they behave identically:

```bash
npm install kn-next          # this alias (pulls in @getknext/core)
npm install @getknext/core   # the real package
```

Docs: https://knext.dev
