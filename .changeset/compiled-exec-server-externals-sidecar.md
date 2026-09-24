---
"@getknext/core": patch
---

The compiled Bun single executable now loads your server's CommonJS external packages (those in `serverExternalPackages` and Next.js's default external list) from `.output/server/node_modules` when that directory is deployed next to the executable, and a runtime `require.resolve()` finds packages there too. When the directory is absent, the copy bundled into the executable is used. Packages that need their own files at runtime, such as `typescript` or native addons such as `sqlite3`, used to fail inside the executable with `Cannot find module` or `Could not find module root`. The executable loads these packages only from that directory. `kn-next build` names the packages it loads from the directory, and warns when one ships a native addon.
