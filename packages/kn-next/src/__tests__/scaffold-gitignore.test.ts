/**
 * #1394 — `knext create` ships no `.gitignore`, so new apps can commit
 * `node_modules`, `.next`, `.output`, compiled `knext-exec*`/
 * `knext-standalone-exec*` binaries, and `.env` files (a secret-leak risk).
 *
 * The fix ships the template as `packages/kn-next/templates/app/gitignore.hbs`
 * (NO leading dot): npm's packer strips any file literally named `.gitignore`
 * from a published tarball regardless of the `files` allowlist, so a template
 * shipped under that exact name would silently vanish from `@getknext/core`
 * on publish and never reach a scaffolded app. `renderScaffold`/
 * `writeScaffold` rename the `gitignore` template key to `.gitignore` at
 * render time, so the rendered/written app still gets the real dotfile.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTemplates, renderScaffold, writeScaffold } from "../cli/create";

describe("#1394: scaffolded .gitignore", () => {
    it("the template ships under `gitignore.hbs`, not `.gitignore.hbs` (npm strips the latter)", () => {
        const templates = loadTemplates();
        expect(templates.has("gitignore")).toBe(true);
        expect(templates.has(".gitignore")).toBe(false);
    });

    it("renderScaffold renders the key as `.gitignore`, not `gitignore`", () => {
        const files = renderScaffold({ name: "acme", version: "0.0.0" });
        expect(files.has(".gitignore")).toBe(true);
        expect(files.has("gitignore")).toBe(false);
    });

    it("the rendered .gitignore covers secrets, build scratch, and both compiled-binary basenames", () => {
        const files = renderScaffold({ name: "acme", version: "0.0.0" });
        const content = files.get(".gitignore") ?? "";
        for (const pattern of [
            "node_modules",
            ".env",
            ".next",
            ".output",
            "knext-exec*",
            "knext-standalone-exec*",
        ]) {
            expect(
                content.includes(pattern),
                `missing pattern: ${pattern}`,
            ).toBe(true);
        }
    });

    it("both --builder variants (default and vinext) get a .gitignore", () => {
        for (const builder of ["default", "vinext"] as const) {
            const files = renderScaffold({
                name: "acme",
                version: "0.0.0",
                builder,
            });
            expect(files.has(".gitignore")).toBe(true);
        }
    });

    it("writeScaffold actually writes a real `.gitignore` file on disk", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-gitignore-"));
        try {
            writeScaffold({ appDir: dir, name: "acme", force: true });
            const target = join(dir, ".gitignore");
            expect(existsSync(target)).toBe(true);
            expect(readFileSync(target, "utf8")).toContain("node_modules");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
