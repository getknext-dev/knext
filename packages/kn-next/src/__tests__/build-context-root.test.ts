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
import { dirname, join, relative, resolve, sep } from "node:path";
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
        expect(requireBuildContext(join(root, "apps", "web"), () => {})).toBe(
            root,
        );
    });
});

/**
 * The walk is UNBOUNDED — it climbs to `/` exactly as Next's does. That is the
 * right inference and the wrong silence: a stray `~/package-lock.json` from one
 * careless `npm install` in `$HOME` makes the home directory the "root", and
 * `docker buildx build <home>` with the scaffolded Dockerfile's `COPY . .`
 * bakes `~/.ssh`, `~/.aws` and `~/.npmrc` into a PUSHED image. That is
 * `security.md`'s "secrets never in container images", reached by an ordinary
 * user mistake — and the hardcode this PR replaced was bounded at two levels,
 * so the walk strictly widened the blast radius.
 *
 * Next mitigates the identical inference with `warnDuplicatedLockFiles`
 * (`next/dist/lib/find-root.js`). knext copied the inference and dropped the
 * warning; this restores it.
 */
describe("#644 — multiple lockfiles are surfaced, not silently resolved", () => {
    it("reports every lockfile found, innermost-first (Next's own shape)", () => {
        const root = repo({
            "yarn.lock": "",
            "apps/web/yarn.lock": "",
            "apps/web/package.json": "{}",
        });
        const app = join(root, "apps", "web");
        expect(findTracingRoot(app).lockFiles).toEqual([
            join(app, "yarn.lock"),
            join(root, "yarn.lock"),
        ]);
    });

    it("WARNS when more than one lockfile was found, naming the extras and the fix", () => {
        const root = repo({
            "yarn.lock": "",
            "apps/web/yarn.lock": "",
            "apps/web/package.json": "{}",
        });
        const app = join(root, "apps", "web");
        const warnings: string[] = [];
        expect(requireBuildContext(app, (m) => warnings.push(m))).toBe(root);
        expect(warnings).toHaveLength(1);
        // The chosen root, the ignored lockfile, and the way to pin it.
        expect(warnings[0]).toContain(root);
        expect(warnings[0]).toContain(join(app, "yarn.lock"));
        expect(warnings[0]).toContain("outputFileTracingRoot");
    });

    it("does NOT warn on the ordinary single-lockfile case", () => {
        // The other half. A warning that always fires is noise, and noise is
        // how the one that matters gets scrolled past.
        const root = repo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
        });
        const warnings: string[] = [];
        requireBuildContext(join(root, "apps", "web"), (m) => warnings.push(m));
        expect(warnings).toEqual([]);
    });
});

/**
 * Next's precedence is EXPLICIT CONFIG FIRST, lockfile walk only as a fallback
 * (`next/dist/server/config.js`: `let rootDir = tracingRoot || turbopackRoot;
 * if (!rootDir) { … findRootDirAndLockFiles(dir) }`). The justification for the
 * whole walk is "the context must contain what `output:'standalone'` traced" —
 * an invariant that breaks precisely when the user has TOLD Next where to
 * trace, which is also what Next's multi-lockfile warning tells them to do.
 *
 * This is also why no new CLI flag is needed as an escape hatch: Next already
 * defines one, and honouring it is a fix rather than new surface.
 */
describe("#644 — an explicit tracing root in next.config wins", () => {
    it("honours outputFileTracingRoot over the lockfile walk", () => {
        const root = repo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
            "apps/web/next.config.ts":
                'export default { outputFileTracingRoot: "/srv/monorepo" };\n',
        });
        expect(requireBuildContext(join(root, "apps", "web"), () => {})).toBe(
            "/srv/monorepo",
        );
    });

    it("honours turbopack.root when outputFileTracingRoot is absent", () => {
        const root = repo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
            "apps/web/next.config.js":
                'module.exports = { turbopack: { root: "/srv/tp" } };\n',
        });
        expect(requireBuildContext(join(root, "apps", "web"), () => {})).toBe(
            "/srv/tp",
        );
    });

    it("prefers outputFileTracingRoot when both are set and disagree (Next's rule)", () => {
        const root = repo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
            "apps/web/next.config.ts":
                "export default {\n" +
                '  outputFileTracingRoot: "/srv/tracing",\n' +
                '  turbopack: { root: "/srv/turbopack" },\n' +
                "};\n",
        });
        expect(requireBuildContext(join(root, "apps", "web"), () => {})).toBe(
            "/srv/tracing",
        );
    });

    it("evaluates the documented path.join(__dirname, …) form, relative to the app", () => {
        const root = repo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
            "apps/web/next.config.ts":
                'import path from "node:path";\n' +
                'export default { outputFileTracingRoot: path.join(__dirname, "../..") };\n',
        });
        expect(requireBuildContext(join(root, "apps", "web"), () => {})).toBe(
            root,
        );
    });

    it("resolves a RELATIVE literal against the app directory, as Next does", () => {
        const root = repo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
            "apps/web/next.config.ts":
                'export default { outputFileTracingRoot: "../.." };\n',
        });
        expect(requireBuildContext(join(root, "apps", "web"), () => {})).toBe(
            root,
        );
    });

    it("answers even with NO lockfile anywhere — the config settled it", () => {
        const root = repo({
            "package.json": "{}",
            "next.config.ts":
                'export default { outputFileTracingRoot: "/srv/explicit" };\n',
        });
        expect(requireBuildContext(root, () => {})).toBe("/srv/explicit");
    });

    it("does NOT warn about duplicate lockfiles when the config already decided", () => {
        // Next skips the warning on this path too: it only warns inside the
        // `if (!rootDir)` fallback. Warning anyway would tell the user to set a
        // setting they have already set.
        const root = repo({
            "yarn.lock": "",
            "apps/web/yarn.lock": "",
            "apps/web/package.json": "{}",
            "apps/web/next.config.ts":
                'export default { outputFileTracingRoot: "/srv/explicit" };\n',
        });
        const warnings: string[] = [];
        requireBuildContext(join(root, "apps", "web"), (m) => warnings.push(m));
        expect(warnings).toEqual([]);
    });

    it("THROWS rather than guessing when the value cannot be evaluated statically", () => {
        // Silently falling back to the walk here is the exact divergence this
        // whole describe exists to close: the user said "trace from X" and we
        // would have shipped a context built from Y.
        const root = repo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
            "apps/web/next.config.ts":
                "export default { outputFileTracingRoot: computeRoot() };\n",
        });
        expect(() =>
            requireBuildContext(join(root, "apps", "web"), () => {}),
        ).toThrow(/outputFileTracingRoot/);
        expect(() =>
            requireBuildContext(join(root, "apps", "web"), () => {}),
        ).toThrow(/next\.config\.ts/);
    });

    it("a config WITHOUT either key falls through to the walk (no false match)", () => {
        // The other half of the scan: a config that merely mentions neither key
        // must not be read as setting one.
        const root = repo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
            "apps/web/next.config.ts":
                'export default { output: "standalone", basePath: "/web" };\n',
        });
        expect(requireBuildContext(join(root, "apps", "web"), () => {})).toBe(
            root,
        );
    });

    it("ignores a commented-out setting (comments are not configuration)", () => {
        const root = repo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
            "apps/web/next.config.ts":
                '// outputFileTracingRoot: "/srv/nope",\n' +
                'export default { output: "standalone" };\n',
        });
        expect(requireBuildContext(join(root, "apps", "web"), () => {})).toBe(
            root,
        );
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

/**
 * Every `.ts` under `src/cli`, RECURSIVELY — never a list of the ones we
 * recall, and never just the top level. A non-recursive `readdirSync` left
 * `src/cli/schema/*.ts` exempt from a guard whose own comment argues that an
 * enumerated check is how the second call site gets missed; a subdirectory is
 * the same omission wearing a different hat.
 */
function cliSources(dir: string = CLI_DIR): { file: string; src: string }[] {
    const out: { file: string; src: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...cliSources(full));
        else if (entry.name.endsWith(".ts")) {
            out.push({
                file: relative(CLI_DIR, full).split(sep).join("/"),
                src: withoutComments(readFileSync(full, "utf8")),
            });
        }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * A fixed walk up from cwd, in any of its spellings: `"../.."`, `".."` twice,
 * `"..", ".."`, `path.join` instead of `resolve`. Matching only the one form
 * the code happened to use is how the guard passes while the bug is back under
 * a different punctuation.
 */
const FIXED_PARENT_WALK =
    /(?:resolve|join)\(\s*process\.cwd\(\)\s*,\s*(?:["'][./\\]*\.\.[^"']*["']\s*,?\s*)+\)/;

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

    it("the scan reaches subdirectories (it once did not)", () => {
        // Both halves. Without this, narrowing the walk back to the top level
        // leaves the check below green over a smaller set — the silent way a
        // scan degrades into an enumeration.
        const files = cliSources().map((s) => s.file);
        expect(files).toContain("deploy.ts");
        expect(files.some((f) => f.includes("/"))).toBe(true);
        expect(files).toContain("schema/preflight.ts");
    });

    it("no cwd-relative parent walk survives anywhere in src/cli", () => {
        // Scanned, not enumerated: the hardcode existed at TWO call sites and
        // the issue named one. An enumerated check is how the second is missed.
        const offenders = cliSources()
            .filter(({ src }) => FIXED_PARENT_WALK.test(src))
            .map(({ file }) => file);
        expect(
            offenders,
            "these files infer the repo root by walking a fixed number of " +
                "directories up from cwd — use requireBuildContext() instead",
        ).toEqual([]);
    });
});

/**
 * #857 — `pnpm-workspace.yaml` is a tracing-root marker, and Next checks it FIRST.
 *
 * knext's walk considered only the five lockfiles, on the stated grounds that
 * "Next does not consult it". That is false for the pinned next 16.2.11:
 * `dist/lib/find-root.js`'s `findWorkRoot` does `findUp.sync('pnpm-workspace.yaml')`
 * BEFORE any lockfile search, and its own comment says why — lockfiles "can be
 * included in the application directory by accident".
 *
 * The consequence is not cosmetic. `create` bakes `standalonePrefix` into the
 * Dockerfile's two COPY sources, its WORKDIR, the CMD's STANDALONE_SERVER_PATH and
 * the app's `start` script. Compute it against a different root than Next uses and
 * every one of those points at a path the build never wrote — while `next build`
 * exits 0.
 */
describe("#857 — pnpm-workspace.yaml roots the trace, and it wins over lockfiles", () => {
    it("treats a pnpm-workspace.yaml ancestor as the root", () => {
        const root = repo({
            "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
            "apps/web/package.json": "{}",
        });
        const app = join(root, "apps", "web");
        expect(findTracingRoot(app).root).toBe(root);
    });

    it("prefers an OUTER pnpm-workspace.yaml over a nearer lockfile, as Next does", () => {
        // The class with the larger blast radius: the app's own marker is a
        // package-lock.json, so it looks lockfile-rooted by every local measure,
        // and the workspace file above it is invisible from the app directory.
        const root = repo({
            "pnpm-workspace.yaml": "packages:\n  - proj/*\n",
            "proj/package-lock.json": "{}",
            "proj/app/package.json": "{}",
        });
        const app = join(root, "proj", "app");
        expect(findTracingRoot(app).root).toBe(root);
    });

    it("installs with pnpm when the root is a pnpm workspace", () => {
        // The generated Dockerfile must install with the manager whose root it
        // found; `npm ci` cannot consume a pnpm workspace.
        const root = repo({
            "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
            "pnpm-lock.yaml": "",
            "apps/web/package.json": "{}",
        });
        expect(findTracingRoot(join(root, "apps", "web")).installCmd).toContain(
            "pnpm",
        );
    });

    it("still prefers a lockfile when no pnpm-workspace.yaml exists anywhere", () => {
        const root = repo({
            "package-lock.json": "{}",
            "apps/web/package.json": "{}",
        });
        expect(findTracingRoot(join(root, "apps", "web")).root).toBe(root);
    });
});

/**
 * #857, design-gate round 2 — finding a workspace file must not END the walk.
 *
 * The first port searched the whole ancestry for `pnpm-workspace.yaml` and returned as
 * soon as it found one. Next does not do that: `findWorkRoot` prefers the workspace file
 * *at each hop*, but `findRootDirAndLockFiles` keeps walking outward until nothing of
 * EITHER kind remains. A lockfile strictly above the outermost workspace file therefore
 * roots the trace — and the early return dropped it, turning a case the old lockfile-only
 * walk got RIGHT into a wrong answer.
 *
 * These two cases are the ones that distinguish the implementations. The four above do
 * not: they pass under both, which is why CI stayed green while the port was wrong.
 *
 * A stray `package-lock.json` in `$HOME`, or at `/` inside a CI image, is ordinary —
 * `warnDuplicatedLockFiles`' own docstring is written about exactly that.
 */
describe("#857 — a marker ABOVE the outermost workspace file still roots the trace", () => {
    it("keeps walking past a pnpm workspace to an npm lockfile above it", () => {
        const root = repo({
            "package-lock.json": "{}",
            "proj/pnpm-workspace.yaml": "packages:\n  - apps/*\n",
            "proj/apps/a/package.json": "{}",
        });
        const app = join(root, "proj", "apps", "a");
        expect(findTracingRoot(app).root).toBe(root);
    });

    it("still installs with pnpm when the chain holds a workspace file", () => {
        // Root and manager are two questions: the root is the npm lockfile's directory,
        // but `npm ci` cannot install the pnpm workspace beneath it.
        const root = repo({
            "yarn.lock": "",
            "proj/pnpm-workspace.yaml": "packages:\n  - apps/*\n",
            "proj/pnpm-lock.yaml": "",
            "proj/apps/a/package.json": "{}",
        });
        const found = findTracingRoot(join(root, "proj", "apps", "a"));
        expect(found.root).toBe(root);
        expect(found.installCmd).toContain("pnpm");
        // More than one marker in the chain — the ambiguity warning is the user's only
        // signal that the inferred root is a guess, and it must survive.
        expect(found.lockFiles.length).toBeGreaterThan(1);
    });
});

/**
 * #857, design-gate residual (a) — frozen-ness belongs to the ROOT.
 *
 * The generated Dockerfile installs at the context root (`WORKDIR /repo`), so
 * `--frozen-lockfile` there needs a lockfile there. Judging it at the innermost
 * workspace file could emit the frozen form against a root that has none — which fails
 * the build outright — or the unfrozen form when the root does have one, giving up
 * reproducibility for nothing.
 */
describe("#857 — frozen-ness is judged at the root the install actually runs in", () => {
    it("is frozen when the ROOT holds pnpm-lock.yaml, even if an inner workspace does not", () => {
        const root = repo({
            "pnpm-workspace.yaml": "packages:\n  - sub/*\n",
            "pnpm-lock.yaml": "",
            "sub/pnpm-workspace.yaml": "packages:\n  - apps/*\n",
            "sub/apps/a/package.json": "{}",
        });
        expect(
            findTracingRoot(join(root, "sub", "apps", "a")).installCmd,
        ).toContain("--frozen-lockfile");
    });

    it("is NOT frozen when only an inner workspace holds the lockfile", () => {
        const root = repo({
            "pnpm-workspace.yaml": "packages:\n  - sub/*\n",
            "sub/pnpm-workspace.yaml": "packages:\n  - apps/*\n",
            "sub/pnpm-lock.yaml": "",
            "sub/apps/a/package.json": "{}",
        });
        const found = findTracingRoot(join(root, "sub", "apps", "a"));
        expect(found.installCmd).toContain("pnpm install");
        expect(found.installCmd).not.toContain("--frozen-lockfile");
    });
});
