/**
 * Every vinext runtime path turns on vinext's own deploy Cache-Control switch
 * (`VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1`) by calling `applyVinextDeployDefault`
 * at process start, before any request, and nothing in the repo overrides it.
 *
 * SCANNED, not enumerated. Entries are found by walking the repo for
 * `knext-(node|bun)-entry.*` and classified by CONTENT, not name:
 *   - serves through `srvx/node` (vinext on Node) → the entry itself must call
 *     `applyVinextDeployDefault(process.env)`;
 *   - serves through `srvx/bun` (compiled executable) → it must be wired into a
 *     `vite.config*` build, and `vinext-compile.mjs` must inject an install
 *     module that calls it ahead of the entry;
 *   - neither → red (an unclassified entry is an unguarded runtime path).
 *
 * Source is scrubbed before matching: comments removed and string/template
 * contents blanked by a QUOTE-AWARE scanner, so neither a comment nor a call
 * inside a multi-line template literal can satisfy the guard, and a `/*` inside
 * a string cannot swallow real code after it.
 *
 * The override scan covers the whole repo (dotfiles included) except
 * `node_modules`, build output, `.claude`, `docs/` and `apps/docs/content`
 * (user-facing prose that documents the `=0` opt-out) and test files (which set
 * `0` on purpose to prove the opt-out). It rejects every override form: `=`/`:`
 * assignment, Dockerfile `ENV NAME value`, empty value, `unset`, `env -u`,
 * `env -i`, and `delete process.env.NAME`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const NAME = "VINEXT_NEXT_DEPLOY_CACHE_CONTROL";
const REPO = join(__dirname, "..", "..", "..", "..");
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".claude",
    ".next",
    ".output",
    "dist",
    "__tests__",
    ".turbo",
]);

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const p = join(dir, name);
        const rel = relative(REPO, p);
        if (rel === "docs" || rel === join("apps", "docs", "content")) continue;
        const st = statSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (!/\.test\.[cm]?[tj]sx?$/.test(name)) out.push(p);
    }
    return out;
}

/**
 * Remove comments and (optionally) blank string/template contents, keeping
 * newlines so line numbers survive. Quote-aware: a comment opener inside a string
 * is text, and a quote inside a comment is text.
 */
export function scrub(src: string, blankStrings: boolean): string {
    let out = "";
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === "/" && n === "/") {
            while (i < src.length && src[i] !== "\n") i++;
        } else if (c === "/" && n === "*") {
            i += 2;
            while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
                if (src[i] === "\n") out += "\n";
                i++;
            }
            i += 2;
        } else if (c === '"' || c === "'" || c === "`") {
            out += c;
            i++;
            while (i < src.length && src[i] !== c) {
                if (src[i] === "\\") {
                    out += blankStrings ? " " : src[i];
                    i++;
                }
                const ch = src[i] ?? "";
                out += blankStrings && ch !== "\n" ? " " : ch;
                i++;
            }
            out += c;
            i++;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

const CALL = /^applyVinextDeployDefault\(process\.env\);$/m;

/** Every override form of the switch found in `src`, one string per hit. */
export function findOverrides(src: string): string[] {
    const hits: string[] = [];
    for (const raw of src.split("\n")) {
        const line = raw.trim();
        if (/^(#|\/\/|\*|\/\*)/.test(line)) continue;
        if (
            !line.includes(NAME) &&
            !/\benv\s+(-\w*i\b|--ignore-environment)/.test(line)
        )
            continue;
        const assign = line.match(
            new RegExp(`${NAME}\\s*[=:](?![=])\\s*["']?([^\\s"',;)\`]*)`),
        );
        if (assign && assign[1] !== "1") hits.push(line);
        const envSpace = line.match(
            new RegExp(`^ENV\\s+${NAME}(?:\\s+["']?([^\\s"']*))?\\s*$`, "i"),
        );
        if (envSpace && envSpace[1] !== "1") hits.push(line);
        if (new RegExp(`\\bunset\\b[^\\n]*${NAME}`).test(line)) hits.push(line);
        if (
            new RegExp(`\\benv\\b[^\\n]*(?:-u\\s*|--unset[=\\s])${NAME}`).test(
                line,
            )
        )
            hits.push(line);
        if (/\benv\s+(-\w*i\b|--ignore-environment)/.test(line))
            hits.push(line);
        if (new RegExp(`\\bdelete\\s+process\\.env\\.${NAME}`).test(line))
            hits.push(line);
    }
    return [...new Set(hits)];
}

const FILES = walk(REPO);
const rel = (p: string) => relative(REPO, p);
const readCode = (p: string) => scrub(readFileSync(p, "utf8"), true);

describe("scanner fixtures (each form must be caught, each safe form must not)", () => {
    it("scrub is quote-aware: a call inside a template literal is not code", () => {
        const src = "const s = `\napplyVinextDeployDefault(process.env);\n`;\n";
        expect(scrub(src, true)).not.toMatch(CALL);
        expect(scrub("applyVinextDeployDefault(process.env);\n", true)).toMatch(
            CALL,
        );
    });

    it("scrub: a block-comment opener inside a string does not eat real code", () => {
        const src =
            'const a = "a/**/b";\napplyVinextDeployDefault(process.env);\n';
        expect(scrub(src, true)).toMatch(CALL);
        expect(
            scrub("/* applyVinextDeployDefault(process.env);\n*/\nx", true),
        ).not.toMatch(CALL);
    });

    const BAD = [
        `ENV ${NAME}=0`,
        `ENV ${NAME} 0`,
        `ENV ${NAME}=`,
        `ENV ${NAME}`,
        `${NAME}=0 node x`,
        `${NAME}=`,
        `  ${NAME}: "0"`,
        `RUN unset ${NAME}`,
        `RUN env -u ${NAME} node x`,
        `RUN env --unset=${NAME} node x`,
        `RUN env -i PATH=$PATH node x`,
        `delete process.env.${NAME};`,
    ];
    for (const b of BAD) {
        it(`flags: ${b}`, () => {
            expect(findOverrides(b)).not.toEqual([]);
        });
    }

    for (const g of [
        `ENV ${NAME}=1`,
        `ENV ${NAME} 1`,
        `  ${NAME}: "1"`,
        `# ${NAME}=0 documents the opt-out`,
        `if (env.${NAME} !== undefined) return;`,
        `env.${NAME} = "1";`,
    ]) {
        it(`allows: ${g}`, () => {
            expect(findOverrides(g)).toEqual([]);
        });
    }
});

describe("vinext runtime paths default VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1", () => {
    const entries = FILES.filter((f) =>
        /(^|\/)knext-(node|bun)-entry\.[^/]*$/.test(f),
    );

    it("finds the vinext entry template(s)", () => {
        const names = entries.map(rel);
        expect(names).toContain(
            "packages/kn-next/templates/app/knext-node-entry.mjs.hbs",
        );
        expect(names).toContain(
            "packages/kn-next/templates/app/knext-bun-entry.mjs.hbs",
        );
    });

    const compile = readFileSync(
        join(REPO, "packages/kn-next/src/adapters/vinext-compile.mjs"),
        "utf8",
    );
    const compileCode = scrub(compile, false);

    /** Modules the compile step imports ahead of the entry. */
    function injectedInstallModules(): string[] {
        const ids = [
            ...compileCode.matchAll(
                /`import \$\{JSON\.stringify\((\w+)\)\};\\n`/g,
            ),
        ].map((m) => m[1]);
        return ids.map((id) => {
            const decl = compileCode.match(
                new RegExp(`const ${id} = \\[([\\s\\S]*?)\\]`),
            );
            const name = decl?.[1].match(/"([\w-]+)\.(?:m?js)"/)?.[1];
            expect(name, `${id} resolves to a module`).toBeTruthy();
            return join(REPO, "packages/kn-next/src/adapters", `${name}.mjs`);
        });
    }

    for (const f of entries) {
        it(`${rel(f)} is guarded`, () => {
            const code = readCode(f);
            const raw = readFileSync(f, "utf8");
            const viaNode = /srvx\/node/.test(raw);
            const viaBun = /srvx\/bun/.test(raw) || /Bun\.serve/.test(raw);
            expect(
                viaNode || viaBun,
                "unclassified entry: serves through neither srvx/node nor srvx/bun",
            ).toBe(true);
            if (viaNode) {
                expect(code).toMatch(CALL);
            }
            if (viaBun) {
                // Compiled through vinext-compile: some vite.config* next to the
                // entry (or the scaffolder template) must wire it in...
                const dir = dirname(f);
                const wired = readdirSync(dir)
                    .filter((n) => /^vite\.config\./.test(n))
                    .some((n) =>
                        /knext-bun-entry/.test(
                            readFileSync(join(dir, n), "utf8"),
                        ),
                    );
                expect(wired, `${rel(f)} is wired into a vite.config*`).toBe(
                    true,
                );
            }
        });
    }

    it("the compile step injects an install module that calls applyVinextDeployDefault, before the entry", () => {
        const mods = injectedInstallModules();
        expect(mods.length).toBeGreaterThan(0);
        const covered = mods.filter((p) =>
            /applyVinextDeployDefault\(/.test(readCode(p)),
        );
        expect(covered.length).toBeGreaterThan(0);
        // ...and the injected imports are prepended to the entry's contents.
        expect(compileCode).toMatch(/wrapped\.contents/);
    });

    it("nothing in the repo overrides the switch to anything but 1", () => {
        const bad: string[] = [];
        for (const f of FILES) {
            let src: string;
            try {
                src = readFileSync(f, "utf8");
            } catch {
                continue;
            }
            if (!src.includes(NAME) && !/\benv\s+-/.test(src)) continue;
            for (const h of findOverrides(src)) bad.push(`${rel(f)}: ${h}`);
        }
        expect(bad).toEqual([]);
    });
});
