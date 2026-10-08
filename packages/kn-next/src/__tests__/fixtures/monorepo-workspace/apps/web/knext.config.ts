/**
 * Deploy config for the monorepo fixture app. Untyped on purpose: the fixture
 * is copied out of @getknext/core's source tree, where
 * `import type { KnativeNextConfig } from "@getknext/core"` does not resolve.
 * The shape is what a real app writes.
 *
 * No `storage` block: static assets are served from the image.
 */
const config = {
    name: "monorepo-web",

    build: "turbopack",
    runtime: "bun",

    registry: "localhost:5001",

    healthCheckPath: "/api/health",
};

export default config;
