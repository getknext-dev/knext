// The cell under test: vinext built for, and run by, node.
//
// Untyped on purpose: this fixture lives inside @getknext/core's own source
// tree, where `import type { KnativeNextConfig } from "@getknext/core"` does
// not resolve for the package typecheck. The shape is what a real app writes.
const config = {
    name: "vinext-node-fixture",
    registry: "example.invalid/knext",
    build: "vinext",
    runtime: "node",
} as const;

export default config;
