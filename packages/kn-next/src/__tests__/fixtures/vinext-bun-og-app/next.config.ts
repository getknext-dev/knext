import type { NextConfig } from "next";

// NOT `output: 'standalone'`: vinext 1.0.1 added unconditional standalone-bundle
// emission (`vinext/dist/build/standalone.js`) whenever next.config's `output`
// is `'standalone'`, and it expects a conventional `vite build` to have already
// produced `dist/{client,server}` -- aborting with "No build output found" when
// it hasn't, which is always true for this fixture (its deployable artifact is
// the `nitro({ preset: 'bun' })` output, not vinext's own standalone bundle).
// `vinext-node-app` (the sibling fixture) carries no next.config.ts at all for
// the same reason.
const config: NextConfig = {};
export default config;
