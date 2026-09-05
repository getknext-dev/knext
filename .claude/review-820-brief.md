# Review brief — PR #820, the kn-next alias package (adversarial)

Defeat it. Repo /Users/banna/alpheya/pocs/knext, branch feat/kn-next-alias-package vs origin/main
(3 files: packages/kn-next-alias/{package.json,bin/kn-next.js,README.md} + tests/kn-next-alias.test.ts
+ lockfile). Small PR — review at full depth anyway; today's session killed decorative assertions
in every PR it reviewed, including one already-removed from this very test file (its absence is
documented in a NOTE comment — judge whether that documented absence is honest or a dodge).

Attack:
1. The resolution walk (bin/kn-next.js): resolve root export → walk up to package.json. Break it:
   pnpm's nested store layout (.pnpm/…/node_modules/@getknext/core — walk-up finds WHOSE
   package.json first?), a core whose root export moves deeper, symlinked installs (npm link).
   Run the shim under a REAL pnpm-installed consumer layout if you can build one quickly.
2. Signal handling: the `child.on('exit')` re-kill pattern — SIGINT to the parent: who dies
   first, does the child get orphaned, is the exit code right? Test with a quick spawn.
3. The version-lockstep test reads BOTH package.jsons from the repo — it can never fail at
   publish time (npm versions drift after publish). Is there a guard shape that actually bites?
4. package.json: files allowlist completeness (LICENSE? npm auto-includes it only if present —
   the repo carries per-package LICENSE files for the @getknext trio; this package has NONE —
   check whether that breaks the repo's licensing claims), engines, repository.directory.
5. The PR body admits release-flow wiring is deferred. Verify nothing in the repo's guards
   (release-action tests, audit-published.mjs closure, install-smoke) BREAKS from this package
   merely existing unpublished — run the relevant suites.

Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-820.md, first line APPROVE or
ISSUES_FOUND, then stop.
