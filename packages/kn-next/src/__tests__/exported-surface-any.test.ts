/**
 * #1054 — Reduce exported-surface `: any` in @getknext/core.
 *
 * `packages/kn-next` publishes as `@getknext/core`; its exported types are the
 * contract consumers program against, so `any` on an EXPORTED signature erodes
 * the type-safety the framework sells. The load-bearing exported-surface `any`
 * was concentrated in the Bun.serve keep-alive guard's hand-written declaration
 * file (and the mirroring JSDoc on its `.mjs` implementation).
 *
 * This guard scans those two files for `: any` type annotations. It is a
 * typing-only invariant: mutation-prove it by reintroducing an `any` on any
 * exported signature and watching it go red.
 *
 * Scope is deliberately the exported guard surface, not internal/test `any`
 * (left for a later cycle) and not `cli/doctor.ts` (owned by #1055).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ADAPTERS = resolve(import.meta.dirname, "../adapters");

/**
 * Match a real `: any` / `any[]` / `=> any` type annotation, but NOT the word
 * `any` inside prose ("Fail-open: any error", "@template …") — the annotations
 * always sit next to type punctuation.
 */
const ANY_ANNOTATION = /:\s*any\b|any\[\]|=>\s*any\b/;

function scan(file: string): string[] {
    const src = readFileSync(resolve(ADAPTERS, file), "utf8");
    return src
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => ANY_ANNOTATION.test(line))
        .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
}

describe("#1054 — no `any` on the exported Bun.serve keep-alive guard surface", () => {
    it("bun-serve-keepalive-guard.d.mts has no `any` type annotation", () => {
        expect(scan("bun-serve-keepalive-guard.d.mts")).toEqual([]);
    });

    it("bun-serve-keepalive-guard.mjs has no `any` in its exported JSDoc types", () => {
        expect(scan("bun-serve-keepalive-guard.mjs")).toEqual([]);
    });
});
