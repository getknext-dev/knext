---
"@getknext/core": patch
---

The Bun executable now runs `after()` work before it exits on `SIGTERM`. The scaffolded `knext-bun-entry.mjs` did not give vinext's `after()` an execution context, so its callbacks were fire-and-forget: a scale-down right after a response logged a clean drain and exited 0 with the callback never run. Each request now runs inside the runtime contract's context, and the shutdown drain waits for that work. The drain in `runtime-contract.mjs` (shared with the Node server entry) also keeps waiting while in-flight work schedules more, so an `after()` callback that calls `after(promise)` during shutdown is no longer cut off. Existing apps pick this up by copying `knext-bun-entry.mjs` and `runtime-contract.mjs` from a freshly created app.
