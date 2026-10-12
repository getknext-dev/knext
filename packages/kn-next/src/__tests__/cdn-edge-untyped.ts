/**
 * `cdn-edge.cjs` is dependency-free CommonJS that ships inside the `--require`
 * preload and has no declaration file; the tests load it untyped, here, once.
 */
import { createRequire } from "node:module";

// biome-ignore lint/suspicious/noExplicitAny: untyped CJS under test
export type Edge = Record<string, any>;

export const requireCjs = createRequire(import.meta.url);

/** A fresh `require` of the module (a duplicated instance, as across webpack layers). */
export function loadEdge(): Edge {
    return requireCjs("../adapters/cdn-edge.cjs") as Edge;
}

export const edge: Edge = loadEdge();

export function edgeModulePath(): string {
    return requireCjs.resolve("../adapters/cdn-edge.cjs");
}
