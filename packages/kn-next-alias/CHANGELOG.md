# kn-next

## 1.3.0-rc.6

### Patch Changes

- Updated dependencies [17b268f]
- Updated dependencies [313f897]
- Updated dependencies [35f4d48]
- Updated dependencies [546cad0]
- Updated dependencies [622f728]
- Updated dependencies [92c4896]
  - @getknext/core@1.3.0-rc.6

## 1.3.0-rc.5

### Patch Changes

- Updated dependencies [3a846a5]
- Updated dependencies [c22b079]
- Updated dependencies [4ef2382]
- Updated dependencies [91f2150]
- Updated dependencies [4f3712e]
- Updated dependencies [81329bb]
  - @getknext/core@1.3.0-rc.5

## 1.3.0-rc.4

### Patch Changes

- Updated dependencies [3c2348f]
- Updated dependencies [e1a5269]
- Updated dependencies [e0238ad]
  - @getknext/core@1.3.0-rc.4

## 1.3.0-rc.3

### Patch Changes

- Updated dependencies [1d06599]
- Updated dependencies [e46b37a]
- Updated dependencies [b167fd4]
- Updated dependencies [ee45ef3]
- Updated dependencies [0cddde7]
- Updated dependencies [598441e]
- Updated dependencies [b679600]
  - @getknext/core@1.3.0-rc.3

## 1.3.0-rc.2

### Patch Changes

- Updated dependencies [3823881]
- Updated dependencies [942ad38]
- Updated dependencies [5b1717d]
- Updated dependencies [5dece2e]
- Updated dependencies [678d1da]
- Updated dependencies [c0a664c]
- Updated dependencies [70c5bbd]
- Updated dependencies [24543bb]
  - @getknext/core@1.3.0-rc.2

## 1.3.0-rc.1

### Patch Changes

- 1aa6b8f: knext's public docs site moved from `knext.dev` to `knext-platform.dev` (`knext.dev` now resolves to an unrelated Cloudflare 403 page). Updates every user-facing `knext.dev` URL in the CLI — help text (`knext --help`), error-message hints (`knext doctor`, missing-config guidance), scaffolded `knext.config.ts` template comments, the asset-upload multi-cloud hint, and package READMEs (`@getknext/core`, `@getknext/lib`, `@getknext/db`, the `kn-next` alias package) — to `knext-platform.dev`. `@getknext/action`'s README is also updated but carries no changeset entry since that package is `private: true` and never publishes. Kubernetes label keys that happen to share the domain string (e.g. the CRD-adjacent `apps.knext.dev/build-id` label) are unaffected; they are not web links.
- Updated dependencies [e5d94c6]
- Updated dependencies [51fbd7e]
- Updated dependencies [1aa6b8f]
- Updated dependencies [4945b10]
- Updated dependencies [02f24e3]
- Updated dependencies [056432d]
  - @getknext/core@1.3.0-rc.1

## 1.0.0-rc.5

### Patch Changes

- Updated dependencies [13780ff]
- Updated dependencies [f89e9db]
- Updated dependencies [da92b15]
- Updated dependencies [d972995]
  - @getknext/core@1.0.0-rc.5

## 1.0.0-rc.4

### Patch Changes

- 0a32380: Security: new apps now scaffold with Next.js 16.3.6. The default template moves from 16.3.5, and the vinext builder template from 16.3.3. Next.js 16.2.0 through 16.3.5 have a critical remote code execution vulnerability in `next/og` `ImageResponse` (GHSA-vcvr-r3jv-pc5j), fixed in 16.3.6. If you scaffolded an app from an earlier release candidate, upgrade it with `npm install next@16.3.6` (or a later 16.3.x). The compatibility credential suite now runs against Next.js 16.3.6.
  
  `@getknext/lib` depends on `@grpc/grpc-js` through `@cerbos/grpc` with a range that already admits the patched 1.14.5 (GHSA-m9gg-hp2v-232j), so a fresh install resolves the fix. If your lockfile still holds `@grpc/grpc-js` 1.14.4 or older, update it.
- Updated dependencies [5afa5f8]
- Updated dependencies [0a32380]
  - @getknext/core@1.0.0-rc.4

## 1.0.0-rc.3

### Patch Changes

- Release-candidate re-cut with no changes to package code. The compatibility credential test harness now covers the sharp version that Next.js 16.3.5 ships, so the Bun credential runs can execute against this candidate.
- Updated dependencies
  - @getknext/core@1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- 7661878: Rewrite package READMEs for v1.0 release: concise one-paragraph introductions, quickstart commands that work, supported platforms table (Node/Bun × Turbopack/Webpack, with the Next.js versions on the compatibility page), and clear links to docs, compatibility, security, and contributing pages. Remove internal references (ADR numbers, issue/PR numbers) to prepare for npm publication.
- Updated dependencies [7661878]
- Updated dependencies [d845497]
- Updated dependencies [26807fc]
- Updated dependencies [28f6d66]
- Updated dependencies [e36eb32]
- Updated dependencies [7c9576d]
  - @getknext/core@1.0.0-rc.2

## 1.0.0-rc.1

### Patch Changes

- Updated dependencies [08661bd]
- Updated dependencies [59ef1d9]
- Updated dependencies [2622780]
- Updated dependencies [40a7323]
- Updated dependencies [d727053]
- Updated dependencies [8c238f3]
- Updated dependencies [848f0ac]
- Updated dependencies [641c4e0]
- Updated dependencies [68ea771]
- Updated dependencies [f068e36]
- Updated dependencies [d0a1d2b]
- Updated dependencies [936979f]
- Updated dependencies [0fe8934]
- Updated dependencies [30ff477]
- Updated dependencies [17ccfc2]
- Updated dependencies
- Updated dependencies [2e136d6]
- Updated dependencies [3c94226]
- Updated dependencies [298de3c]
- Updated dependencies [fa9e55a]
- Updated dependencies [631b7b5]
- Updated dependencies [8326926]
  - @getknext/core@1.0.0-rc.1

## 0.4.3

### Patch Changes

- Updated dependencies [445059f]
- Updated dependencies [6a94212]
- Updated dependencies [ff1c6a8]
- Updated dependencies [e7f33dc]
- Updated dependencies [deaaa5a]
- Updated dependencies [15dcdc1]
- Updated dependencies [3a84e65]
  - @getknext/core@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies [210a2b7]
  - @getknext/core@0.4.2

## 0.4.1

### Patch Changes

- Republish the @getknext/* group at 0.4.1. The 0.4.0 tarballs shipped unresolvable `workspace:` ranges in their sibling dependencies (EUNSUPPORTEDPROTOCOL on install), so `@latest` was rolled back to 0.3.1. The release lane now rewrites `workspace:` ranges to the concrete published version at publish time and a guard verifies the packed tarballs before publishing (see docs/incidents/2026-09-08-npm-release-workspace-and-partial-publish.md). This patch re-ships the 0.4.0 content — the create verb, the OTel fix, and the rest — as an installable 0.4.1.
- Updated dependencies
  - @getknext/core@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [a450c9f]
  - @getknext/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [bf03457]
- Updated dependencies [588d1ef]
  - @getknext/core@0.3.1
