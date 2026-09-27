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
 * `selfContained: true` on a next-standalone builder + `runtime: 'bun'` is
 * the exact shape #1522 wires end to end: the CR carries `spec.selfContained`
 * (cr-builder emits it for `build !== 'vinext' && runtime === 'bun'`), and
 * the operator's `containerCommand` branch leaves `Command` nil for it —
 * this profile is what proves that on a REAL operator-rendered pod (a kind
 * lane, not just the plain-docker proof in
 * `standalone-self-contained-image.docker-e2e.test.ts`), closing the N2 half
 * of the "no kind lane boots the standalone image via the operator" gap.
 *
 * `build: 'webpack'`, not 'turbopack': the fixture pins next@16.3.3, which
 * `knext deploy`'s #1372 pre-build guard (project-build.ts) refuses on the
 * turbopack target — the adapter+standalone+turbopack regression fixed
 * upstream in 16.3.5. The docker-e2e sibling never hits that guard (it runs
 * a bare `next build`), so the fixture itself stays on the turbopack default;
 * the kind workflow stages a throwaway copy and switches ITS build script
 * to `next build --webpack` to match this profile. The builder is not the
 * claim here — the CR shape, the nil Command and the self-contained image
 * stage are all keyed on the bun runtime, not on the builder.
 *
 * No `storage` block — this fixture serves everything from the image
 * (ADR-0047 image-served static mode), same as the file-manager e2e profile
 * when it drops `storage`.
 *
 * Untyped on purpose: this fixture lives inside @getknext/core's own source
 * tree, where `import type { KnativeNextConfig } from "@getknext/core"` does
 * not resolve for the package typecheck (same reason `vinext-node-app/kn-next.config.ts`
 * is untyped). The shape is what a real app writes.
 */
const config = {
    name: "standalone-sc-e2e",

    build: "webpack",
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
