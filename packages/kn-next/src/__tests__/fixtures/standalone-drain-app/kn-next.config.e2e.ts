import type { KnativeNextConfig } from "@getknext/core";

/**
 * #1522 / #1517 — the config profile for the self-contained-standalone kind
 * e2e (`.github/workflows/standalone-self-contained-operator-e2e.yml`).
 *
 * `standalone-drain-app` is otherwise a docker-only fixture (no adapter
 * wiring, no `@getknext/core` dependency) — `knext build`/`knext deploy` run
 * the app's own `npm run build` (plain `next build`, `output: 'standalone'`)
 * and then stage/compile from `.next/standalone` themselves, so it needs
 * nothing more to be deployed for real through the CLI.
 *
 * `selfContained: true` on `build: 'turbopack'` + `runtime: 'bun'` is the
 * exact shape #1522 wires end to end: the CR carries `spec.selfContained`,
 * and the operator's `containerCommand` branch leaves `Command` nil for it —
 * this profile is what proves that on a REAL operator-rendered pod (a kind
 * lane, not just the plain-docker proof in
 * `standalone-self-contained-image.docker-e2e.test.ts`), closing the N2 half
 * of the "no kind lane boots the standalone image via the operator" gap.
 *
 * No `storage` block — this fixture serves everything from the image
 * (ADR-0047 image-served static mode), same as the file-manager e2e profile
 * when it drops `storage`.
 */
const config: KnativeNextConfig = {
    name: "standalone-sc-e2e",

    build: "turbopack",
    runtime: "bun",
    selfContained: true,

    registry: "localhost:5001",

    healthCheckPath: "/api/health",

    scaling: {
        minScale: 0,
        maxScale: 1,
        memoryRequest: "256Mi",
        memoryLimit: "512Mi",
    },
};

export default config;
