/**
 * #1843 — the scaffold's runtime seam: a NODE app's package.json declares the
 * Redis client its cache handler imports.
 *
 * The node cache handler imports `ioredis` literally, and `@getknext/core`
 * already depends on it, so tracing finds it either way. Declaring it on the
 * app too means the app's own install always has it at the top level,
 * whatever the package manager's hoisting does. The bun runtime uses Bun's
 * built-in client and gets no such dependency.
 *
 * `runtime` is the seam the `knext create` prompts set; until then the CLI
 * passes nothing and the default runtime applies.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_RUNTIME_ID } from "../adapters/artifact-contract";
import { renderScaffold } from "../cli/create";

const CORE_PKG = JSON.parse(
    readFileSync(join(resolve(__dirname, "..", ".."), "package.json"), "utf8"),
);

function pkgFor(runtime?: "node" | "bun") {
    const files = renderScaffold({
        name: "redis-app",
        version: "1.2.3",
        ...(runtime === undefined ? {} : { runtime }),
    });
    const text = files.get("package.json");
    if (text === undefined) throw new Error("no package.json rendered");
    return { text, json: JSON.parse(text) };
}

describe("knext create — runtime seam (#1843)", () => {
    it("node → package.json depends on ioredis at @getknext/core's own range", () => {
        const { json } = pkgFor("node");
        expect(json.dependencies.ioredis).toBe(CORE_PKG.dependencies.ioredis);
    });

    it("bun → no ioredis (the bun handler uses Bun's built-in client)", () => {
        expect(pkgFor("bun").json.dependencies.ioredis).toBeUndefined();
    });

    it("no runtime given → the default runtime's package.json, byte for byte", () => {
        expect(DEFAULT_RUNTIME_ID).toBe("bun");
        expect(pkgFor().text).toBe(pkgFor("bun").text);
    });

    it("node changes nothing else in package.json", () => {
        const node = pkgFor("node").json;
        const base = pkgFor("bun").json;
        delete node.dependencies.ioredis;
        expect(node).toEqual(base);
    });

    it("node leaves every other scaffolded file untouched", () => {
        const node = renderScaffold({
            name: "redis-app",
            version: "1.2.3",
            runtime: "node",
        });
        const base = renderScaffold({ name: "redis-app", version: "1.2.3" });
        expect([...node.keys()].sort()).toEqual([...base.keys()].sort());
        for (const [rel, text] of base) {
            if (rel === "package.json") continue;
            expect(node.get(rel), rel).toBe(text);
        }
    });
});
