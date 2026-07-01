# Upstream next/jest bug: unescaped `/.next/` ignore regex breaks test discovery

**Status:** patched harness-side in our compat-suite CI (`.github/workflows/test-e2e-deploy.yml`,
step "Patch next/jest unescaped /.next/ ignore pattern"). Not yet filed upstream — issue draft
below, filing is a maintainer decision.

## The bug

`next/jest` injects `testPathIgnorePatterns: ['/node_modules/', '/.next/']` into every jest
config it creates — `packages/next/src/build/jest/jest.ts:156` (at v16.0.3):

```ts
testPathIgnorePatterns: ['/node_modules/', '/.next/'],
```

Jest treats these entries as **regexes** matched against the absolute test path. The dot in
`/.next/` is unescaped, so the pattern means "slash, **any character**, `next`, slash" — it
matches any `?next/` path segment, not just `.next` build output.

Consequence: if the absolute path of the checkout contains any directory whose name ends in
`next` (preceded by at least one character), **every test file is excluded** and jest reports
`No tests found` / `Pattern: <file> - 0 matches`. GitHub Actions makes this easy to hit: a repo
named `knext` is checked out under `/home/runner/work/knext/knext/`, and `/knext/` matches
`/.next/`. Other affected names: `onext`, `my-next`, `vnext`, …

## Repro one-liner

```sh
node -e "console.log(/\/.next\//.test('/home/runner/work/knext/knext/next.js/test/e2e/404-page-router/index.test.ts'))"
# -> true  (the '/knext/' segment matches the unescaped '/.next/' regex)
```

Or end-to-end: clone `vercel/next.js` into any path containing a `?next/` segment, create a
jest config via `next/jest`, and run any test — jest finds 0 files.

## How this bit knext's compat suite

Our official-compatibility-suite CI runs next.js's deploy-mode e2e tests against the knext
adapter. Every shard reported `Pattern: test/e2e/... - 0 matches` while a local repro with the
identical config discovered tests fine — the only difference was the workspace path (the local
clone path had no `?next/` segment). Proven in debug run 28551192374: after escaping the dot,
`jest --listTests` went from 0 to 1707 candidates and real deploy tests executed.

## Our harness-side patch

The CI step resolves `next/jest` from the next.js checkout (`require.resolve('next/jest')`,
following the entry stub's relative requires to `packages/next/dist/build/jest/jest.js`) and
rewrites the unescaped string literal `'/.next/'` to the escaped `'/\\.next/'`. It prints
`APPLIED`/`NOOP` (a NOOP is fine once upstream fixes the escape) and fails only if the dist
file is missing entirely.

## Ready-to-file upstream issue draft (vercel/next.js)

**Title:** `next/jest`: unescaped `/.next/` in `testPathIgnorePatterns` excludes every test
when the project path contains a `?next/` segment

**Body:**

> `next/jest` injects `testPathIgnorePatterns: ['/node_modules/', '/.next/']`
> (`packages/next/src/build/jest/jest.ts:156` at v16.0.3). Jest interprets these as regexes
> against the absolute test path, and the dot in `/.next/` is unescaped — it matches any
> `?next/` path segment, not just the `.next` build directory.
>
> If the project's absolute path contains a directory like `/knext/`, `/vnext/`, or
> `/my-next/`, every test file matches the ignore pattern and jest reports "No tests found".
> This is easy to hit on GitHub Actions, where a repo named e.g. `knext` lives at
> `/home/runner/work/knext/knext/`.
>
> **Repro:**
> ```sh
> node -e "console.log(/\/.next\//.test('/home/runner/work/knext/knext/src/app.test.ts'))"
> # true — the '/knext/' segment matches
> ```
> Any `next/jest`-based config run from such a path discovers 0 tests.
>
> **Expected:** only the `.next` build output is ignored.
>
> **Fix:** escape the dot: `testPathIgnorePatterns: ['/node_modules/', '/\\.next/']` (the
> sibling `modulePathIgnorePatterns` entries elsewhere in the repo already escape it).
