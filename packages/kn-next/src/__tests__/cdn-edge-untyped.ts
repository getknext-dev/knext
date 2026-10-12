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

/** The accepted shape `parseRoutingArtifact` returns (the rejected shape is `{ ok: false, reason }`). */
export interface OkArtifact {
    ok: true;
    basePath: string;
    i18n: { locales: string[] } | null;
    none: boolean;
    matchers: RegExp[];
    matchAll: boolean;
}

/** Parse an artifact that the test expects to be ACCEPTED; narrows the union. */
export function okArtifact(text: string): OkArtifact {
    const a = edge.parseRoutingArtifact(text) as
        | OkArtifact
        | { ok: false; reason: string };
    if (!a.ok) throw new Error(`routing artifact rejected: ${a.reason}`);
    return a;
}
