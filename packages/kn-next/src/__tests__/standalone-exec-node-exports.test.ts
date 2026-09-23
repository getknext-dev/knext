/**
 * `resolveExportsUnderNode` — re-resolving a package's `exports` under Node's
 * conditions for the compiled standalone-on-Bun cell.
 *
 * Why it exists: the compile targets `bun`, so the bundler prefers a package's
 * `"bun"` export condition. `next build` traces under Node, so a `"bun"` target
 * (react-dom's `./server` -> `server.bun.js`) can be absent from the traced
 * standalone tree while the exports map still names it — and the resolver
 * then fails the whole specifier. The compile retries such a specifier with
 * exactly the conditions the trace used, never `bun`.
 */

import { describe, expect, it } from "bun:test";
import { resolveExportsUnderNode } from "../adapters/standalone-exec-entry.mjs";

/** react-dom 19.2's real `./server` entry (abridged to the conditions). */
const REACT_DOM_EXPORTS = {
    ".": "./index.js",
    "./server": {
        "react-server": "./server.react-server.js",
        workerd: "./server.edge.js",
        bun: "./server.bun.js",
        deno: "./server.browser.js",
        worker: "./server.browser.js",
        node: "./server.node.js",
        "edge-light": "./server.edge.js",
        browser: "./server.browser.js",
        default: "./server.node.js",
    },
};

describe("resolveExportsUnderNode", () => {
    it("never picks the bun condition — picks node, the condition the trace used", () => {
        expect(resolveExportsUnderNode(REACT_DOM_EXPORTS, "./server")).toBe(
            "./server.node.js",
        );
    });

    it("never picks react-server, even though it is listed first", () => {
        expect(resolveExportsUnderNode(REACT_DOM_EXPORTS, "./server")).not.toBe(
            "./server.react-server.js",
        );
    });

    it("resolves a plain string subpath", () => {
        expect(resolveExportsUnderNode(REACT_DOM_EXPORTS, ".")).toBe(
            "./index.js",
        );
    });

    it("walks nested conditions (node -> require -> default)", () => {
        const exp = {
            "./x": {
                node: { import: "./x.mjs", require: "./x.cjs" },
                default: "./x.js",
            },
        };
        expect(resolveExportsUnderNode(exp, "./x")).toBe("./x.cjs");
    });

    it("takes the first resolvable entry of an array target", () => {
        expect(
            resolveExportsUnderNode(
                { ".": [{ bun: "./b.js" }, "./n.js"] },
                ".",
            ),
        ).toBe("./n.js");
    });

    it("accepts a bare string / sugar exports for the package root only", () => {
        expect(resolveExportsUnderNode("./main.js", ".")).toBe("./main.js");
        expect(resolveExportsUnderNode("./main.js", "./other")).toBeUndefined();
        expect(
            resolveExportsUnderNode({ node: "./n.js", default: "./d.js" }, "."),
        ).toBe("./n.js");
    });

    it("returns undefined for an unexported subpath (the compile then leaves it external)", () => {
        expect(
            resolveExportsUnderNode(REACT_DOM_EXPORTS, "./nope"),
        ).toBeUndefined();
    });

    it("returns undefined when only non-Node conditions exist", () => {
        expect(
            resolveExportsUnderNode(
                { ".": { bun: "./b.js", browser: "./w.js" } },
                ".",
            ),
        ).toBeUndefined();
    });
});
