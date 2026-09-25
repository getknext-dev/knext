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

import { describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createMain,
    loadTemplates,
    renderScaffold,
    writeScaffold,
} from "../cli/create";

/**
 * Real `git check-ignore`, not a substring/regex re-implementation of
 * gitignore semantics — the rev-1393 review's own point: a hand-rolled
 * matcher is how a real defect (unanchored `dist`/`build`/`server`
 * silently swallowing `src/server/`, `src/app/build/`) went unnoticed.
 * Returns whether `relPath` (already created on disk under `repoDir`) is
 * ignored by the given `.gitignore` content.
 */
function isGitIgnored(gitignoreContent: string, relPath: string): boolean {
    const repoDir = mkdtempSync(join(tmpdir(), "knext-gitcheck-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repoDir });
        writeFileSync(join(repoDir, ".gitignore"), gitignoreContent, "utf8");
        const target = join(repoDir, relPath);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, "// test file\n", "utf8");
        try {
            execFileSync("git", ["check-ignore", "--quiet", relPath], {
                cwd: repoDir,
            });
            return true; // exit 0 = ignored
        } catch (err) {
            // `git check-ignore` exits 1 for "not ignored" — a real result,
            // not a failure. Any OTHER exit code is a real error and should
            // still surface (e.g. exit 128 for a malformed pattern).
            const status = (err as { status?: number }).status;
            if (status === 1) return false;
            throw err;
        }
    } finally {
        rmSync(repoDir, { recursive: true, force: true });
    }
}

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

    describe("#1398 (rev-1393): patterns must be ANCHORED — a bare `dist`/`build`/`server`/`coverage` also matches a legitimate NESTED path with that name", () => {
        const content = renderScaffold({ name: "acme", version: "0.0.0" }).get(
            ".gitignore",
        ) as string;

        it("does NOT ignore a real Next.js src/server/ directory (a bare `server` pattern would)", () => {
            expect(isGitIgnored(content, "src/server/db.ts")).toBe(false);
        });

        it("does NOT ignore an app-router route literally named build/ (a bare `build` pattern would)", () => {
            expect(isGitIgnored(content, "src/app/build/page.tsx")).toBe(false);
        });

        it("does NOT ignore an app-router route literally named coverage/ (a bare `coverage` pattern would)", () => {
            expect(isGitIgnored(content, "src/app/coverage/page.tsx")).toBe(
                false,
            );
        });

        it("still ignores the ROOT-level dist/, build/, server, coverage/ build-scratch directories", () => {
            expect(isGitIgnored(content, "dist/index.js")).toBe(true);
            expect(isGitIgnored(content, "build/index.js")).toBe(true);
            expect(isGitIgnored(content, "coverage/lcov.info")).toBe(true);
            // `server` (no slash in the template) names a FILE at the repo
            // root in this scaffold's own layout — never a directory a user
            // would legitimately create there.
            expect(isGitIgnored(content, "server")).toBe(true);
        });

        it("still ignores node_modules/.next/.env wherever they legitimately are (unaffected by the anchoring fix)", () => {
            expect(isGitIgnored(content, "node_modules/foo/index.js")).toBe(
                true,
            );
            expect(isGitIgnored(content, ".next/cache/x")).toBe(true);
            expect(isGitIgnored(content, ".env")).toBe(true);
            expect(isGitIgnored(content, ".env.local")).toBe(true);
        });

        it("does not un-ignore .env.local via the .env.example negation (real risk the weak includes()-only check missed)", () => {
            // A naive `content.includes('.env')` check would pass even if
            // `!.env.example` were the ONLY .env-related line — proving the
            // negation is scoped to exactly `.env.example` and nothing else
            // needs `git check-ignore`, not string search.
            expect(isGitIgnored(content, ".env.example")).toBe(false);
            expect(isGitIgnored(content, ".env.local")).toBe(true);
        });
    });
});

describe("#1398 (rev-1393): --force must not silently clobber a user's own pre-existing .gitignore", () => {
    it("skips writing .gitignore when the app already has one, even under --force", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-gitignore-force-"));
        try {
            const userContent = "# my own custom ignores\nsecrets.local\n";
            writeFileSync(join(dir, ".gitignore"), userContent, "utf8");
            // A pre-existing package.json too, so this exercises the REAL
            // "add knext to an app I already have" --force path, not just
            // the single-file case.
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "acme" }),
                "utf8",
            );
            writeScaffold({ appDir: dir, name: "acme", force: true });
            expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
                userContent,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("still writes .gitignore normally when the app has none yet", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-gitignore-nofile-"));
        try {
            writeScaffold({ appDir: dir, name: "acme", force: true });
            expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(
                "node_modules",
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("removes the kept .gitignore from writeScaffold's returned map — it was NOT created", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-gitignore-kept-map-"));
        try {
            writeFileSync(join(dir, ".gitignore"), "secrets.local\n", "utf8");
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "acme" }),
                "utf8",
            );
            const files = writeScaffold({
                appDir: dir,
                name: "acme",
                force: true,
            });
            expect(files.has(".gitignore")).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("still returns .gitignore in the map when it was actually written", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-gitignore-written-map-"));
        try {
            const files = writeScaffold({
                appDir: dir,
                name: "acme",
                force: true,
            });
            expect(files.has(".gitignore")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("#1398 (rev-1393 round 2): createMain's --force output does not falsely claim .gitignore was Created", () => {
    /** Capture what createMain writes to stdout/stderr for one invocation. */
    async function capture(
        argv: string[],
    ): Promise<{ code: number; out: string; err: string }> {
        let out = "";
        let err = "";
        const outSpy = spyOn(process.stdout, "write").mockImplementation(
            (chunk: unknown) => {
                out += String(chunk);
                return true;
            },
        );
        const errSpy = spyOn(process.stderr, "write").mockImplementation(
            (chunk: unknown) => {
                err += String(chunk);
                return true;
            },
        );
        try {
            const code = await createMain(argv);
            return { code, out, err };
        } finally {
            outSpy.mockRestore();
            errSpy.mockRestore();
        }
    }

    it('does not print "Created … .gitignore" when an existing .gitignore was kept under --force', async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-gitignore-cli-kept-"));
        try {
            writeFileSync(join(dir, ".gitignore"), "secrets.local\n", "utf8");
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "acme" }),
                "utf8",
            );
            const { code, out } = await capture([
                dir,
                "--name",
                "acme",
                "--force",
            ]);
            expect(code).toBe(0);
            // Only the "Created N file(s)" LISTING block (up to the first
            // blank line) must be free of `.gitignore` — the note that
            // follows is expected to name it (that's the honest report).
            const listingBlock = out.split("\n\n")[0] ?? "";
            expect(listingBlock).not.toContain(".gitignore");
            expect(out.toLowerCase()).toContain(
                "kept your existing .gitignore",
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("warns when the kept .gitignore does not ignore .env", async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-gitignore-cli-noenv-"));
        try {
            writeFileSync(join(dir, ".gitignore"), "*.log\n", "utf8");
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "acme" }),
                "utf8",
            );
            const { code, out } = await capture([
                dir,
                "--name",
                "acme",
                "--force",
            ]);
            expect(code).toBe(0);
            expect(out.toLowerCase()).toContain(".env");
            expect(out.toLowerCase()).toMatch(/warn/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("does NOT warn when the kept .gitignore already ignores .env", async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-gitignore-cli-hasenv-"));
        try {
            writeFileSync(join(dir, ".gitignore"), ".env\n.env.*\n", "utf8");
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "acme" }),
                "utf8",
            );
            const { code, out } = await capture([
                dir,
                "--name",
                "acme",
                "--force",
            ]);
            expect(code).toBe(0);
            expect(out.toLowerCase()).not.toMatch(/warn.*\.env|\.env.*warn/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
