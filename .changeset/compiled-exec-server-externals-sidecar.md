---
"@getknext/core": patch
---

The compiled Bun single executable now loads your server's external packages (those in `serverExternalPackages` and Next.js's default external list) from `.output/server/node_modules` when that directory is deployed next to the executable, and falls back to the copy bundled into the executable when it is not. Packages that need their own files at runtime, such as `typescript` (for `twoslash`) or native addons such as `sqlite3`, used to fail inside the executable with `Cannot find module` or `Could not find module root`. `kn-next build` now names these packages, and warns when one ships a native addon, because a native addon can only load from that directory.
