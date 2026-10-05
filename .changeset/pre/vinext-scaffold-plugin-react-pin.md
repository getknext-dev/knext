---
"@getknext/core": patch
---

Fixed `npm install` failing in every new app created with `knext create --builder vinext` (React
Compiler is on by default). `@vitejs/plugin-react` 6.1.2, published on 2026-10-05, requires a newer
`oxc-transform-react` than the scaffold pinned, so npm refused to install with an `ERESOLVE` peer
dependency error. New vinext scaffolds now pin `@vitejs/plugin-react` to exactly `6.1.2` and
`oxc-transform-react` to `^0.152.0`, so the two only change together.

An existing vinext app that hits the error updates the same two `devDependencies` in its
`package.json`:

```json
{
  "devDependencies": {
    "@vitejs/plugin-react": "6.1.2",
    "oxc-transform-react": "^0.152.0"
  }
}
```

Escalation trigger acknowledged: this changes the `knext create` scaffold output (CLI surface) for
the vinext template with React Compiler on; no config schema, CRD or public API change.
