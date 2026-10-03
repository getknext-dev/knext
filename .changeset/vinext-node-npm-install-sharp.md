---
"@getknext/core": patch
---

Fixed a `build: 'vinext'` + `runtime: 'node'` image build failure after the documented `npm install` step: `knext build`/`knext deploy` could not stage sharp's native addon for the deployed image unless the app also had a `bun.lock`, so an app installed with plain `npm install` (no bun involved at all, which is the normal case for a `--runtime node` app) failed with sharp's own "Could not load the sharp module using the linuxmusl-x64 runtime" during the image build. The staging step now also reads npm's `package-lock.json`, so `npm install` is sufficient — Node remains a first-class option alongside Bun. No action needed; rebuild and redeploy to pick up the fix.
