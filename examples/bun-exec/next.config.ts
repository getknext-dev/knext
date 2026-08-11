import type { NextConfig } from 'next';

// The CONTROL arm's config. `output: 'standalone'` is what makes the node arm a
// self-contained server directory, mirroring what the bun arm gets from
// `--compile`: one shippable artifact, no `next start` wrapper.
const config: NextConfig = { output: 'standalone' };
export default config;
