# kn-next

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
