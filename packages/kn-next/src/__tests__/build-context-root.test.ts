/**
 * #644 — ONE root-inference rule for the docker build context.
 *
 * `deploy.ts` (and `preview.ts`) hardcoded `resolve(process.cwd(), "../..")`:
 * an assertion that every knext app lives at `apps/<name>` inside a monorepo.
 * `create.ts` infers the same fact by walking up to the OUTERMOST lockfile —
 * exactly what next 16.2's `findRootDirAndLockFiles` does to pick
 * `outputFileTracingRoot`. The two agree for `apps/<name>` and disagree
 * everywhere else, and `kn-next create` (#642) makes "everywhere else" — a flat
 * single-app repo — the ordinary case for the audience that verb exists for.
 *
 * The lockfile walk wins, and not merely because it is layout-independent: the
 * build context has to contain what Next actually traced into
 * `.next/standalone`, and Next chose that directory by this rule. A layout
 * guess that disagrees with Next produces an image missing files the server
 * needs — or, in a flat repo, a context two levels ABOVE the project.
 *
 * Cases pinned here: flat repo, `apps/<name>` (the no-regression case), a
 * deeper nesting than two levels, and no lockfile at all — which FAILS LOUDLY
 * rather than shipping an arbitrary directory as the context.
 */
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveLayout } from "../cli/create";
import { findTracingRoot, requireBuildContext } from "../cli/tracing-root";

/** A throwaway repo: `dirs` created, `files` written relative to its root. */
function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "knext-root-"));
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(root, rel);
        mkdirSync(resolve(abs, ".."), { recursive: true });
        writeFileSync(abs, contents);
    }
    return root;
}

describe("#644 — build context = the lockfile-inferred tracing root", () => {
    it("a flat single-app repo builds from the app directory itself", () => {
        const root = repo({
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            "package.json": "{}",
        });
        expect(requireBuildContext(root)).toBe(root);
    });

    it("apps/<name> in a monorepo still builds from the repo root (no regression)", () => {
        const root = repo({
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            "apps/web/package.json": "{}",
        });
        const app = join(root, "apps", "web");
        expect(requireBuildContext(app)).toBe(root);
        // The behaviour the hardcode had, preserved exactly for this layout.
        expect(requireBuildContext(app)).toBe(resolve(app, "../.."));
    });

    it("an app nested deeper than two levels still builds from the repo root", () => {
        const root = repo({
            "package-lock.json": "{}",
            "services/frontend/apps/web/package.json": "{}",
        });
        const app = join(root, "services", "frontend", "apps", "web");
        expect(requireBuildContext(app)).toBe(root);
        expect(requireBuildContext(app)).not.toBe(resolve(app, "../.."));
    });

    it("prefers the OUTERMOST lockfile when the app carries one too", () => {
        const root = repo({
            "yarn.lock": "",
            "apps/web/yarn.lock": "",
            "apps/web/package.json": "{}",
        });
        expect(requireBuildContext(join(root, "apps", "web"))).toBe(root);
    });

    it("fails loudly with an actionable message when there is no lockfile", () => {
        const root = repo({ "package.json": "{}" });
        expect(() => requireBuildContext(root)).toThrow(/lockfile/i);
        // The message must name the directory searched and a way out, not just
        // report failure — an unactionable throw is a worse hardcode.
        expect(() => requireBuildContext(root)).toThrow(new RegExp(root));
        expect(findTracingRoot(root).root).toBeNull();
    });

    it("create.ts and deploy.ts resolve the SAME root (one rule, not two)", () => {
        // Annotated at the point of declaration. Left to inference, TypeScript
        // widens the array into a UNION of these object literals, giving each
        // member the others' keys as `undefined` — which `Record<string,
        // string>` rightly rejects. Loosening `repo`'s parameter instead would
        // let a genuinely absent file through, which is the opposite of what
        // these cases assert.
        const cases: { files: Record<string, string>; app: string }[] = [
            { files: { "pnpm-lock.yaml": "", "package.json": "{}" }, app: "" },
            {
                files: { "pnpm-lock.yaml": "", "apps/web/package.json": "{}" },
                app: "apps/web",
            },
            {
                files: { "bun.lock": "", "a/b/c/web/package.json": "{}" },
                app: "a/b/c/web",
            },
        ];
        for (const { files, app } of cases) {
            const root = repo(files);
            const appDir = app ? join(root, app) : root;
            expect(resolveLayout(appDir).root).toBe(
                requireBuildContext(appDir),
            );
        }
    });
});

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../cli");

/** Drop comments: the ban is on CODE, and the fix's own docblock quotes it. */
function withoutComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every `.ts` under `src/cli`, scanned — never a list of the ones we recall. */
function cliSources(): { file: string; src: string }[] {
    return readdirSync(CLI_DIR)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => ({
            file: f,
            src: withoutComments(readFileSync(join(CLI_DIR, f), "utf8")),
        }));
}

describe("#644 — no call site keeps its own root rule", () => {
    it.each([
        "deploy.ts",
        "preview.ts",
    ])("%s asks the shared inference for its build context", (file) => {
        // Comments stripped here too: a file that only MENTIONS the helper in
        // prose while still hardcoding its own walk would otherwise pass.
        const src = withoutComments(readFileSync(join(CLI_DIR, file), "utf8"));
        expect(src).toContain("requireBuildContext(");
    });

    it("no cwd-relative parent walk survives anywhere in src/cli", () => {
        // Scanned, not enumerated: the hardcode existed at TWO call sites and
        // the issue named one. An enumerated check is how the second is missed.
        const offenders = cliSources()
            .filter(({ src }) =>
                /resolve\(\s*process\.cwd\(\)\s*,\s*["'](\.\.\/)+\.\.["']\s*\)/.test(
                    src,
                ),
            )
            .map(({ file }) => file);
        expect(
            offenders,
            "these files infer the repo root by walking a fixed number of " +
                "directories up from cwd — use requireBuildContext() instead",
        ).toEqual([]);
    });
});
