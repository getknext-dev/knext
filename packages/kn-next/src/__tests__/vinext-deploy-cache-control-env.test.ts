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
 *     `vite.config*` build (see `isBunEntryWired`), and `vinext-compile.mjs` must
 *     inject an install module that calls it ahead of the entry;
 *   - neither → red (an unclassified entry is an unguarded runtime path).
 *
 * THE OVERRIDE SCAN IS AN ALLOWLIST, NOT A BLACKLIST. Three rounds of
 * blacklisting (`=0`, `unset`, `??=`, `os.Setenv`, comment-split pairs, ...)
 * each leaked the next spelling, so the question is inverted: every non-test
 * line that mentions the variable must match a KNOWN-SAFE form, and anything
 * else — including a form nobody has thought of — fails closed with the line
 * printed. The safe forms (`findUnsafeMentions`):
 *   - assignment of the literal `1`: `NAME=1`, `ENV NAME=1`, `ENV NAME 1`,
 *     `export NAME=1`, `NAME: "1"`, `env.NAME = "1"` / `process.env["NAME"] = "1"`;
 *   - a k8s / Go name-value pair whose value line is exactly `1` (a comment
 *     between the two lines is stripped first; `valueFrom`, an ambiguous
 *     neighbour or a non-`1` value fails);
 *   - the Go one-line struct `{Name: "NAME", Value: "1"}` (either order);
 *   - exactly two READ shapes, each bound to its file: the early-return guard
 *     inside `applyVinextDeployDefault` (`adapters/response-cache-control.mjs`)
 *     and the fixture probe `process.env.NAME ?? null`.
 * Every safe form is matched against the WHOLE line, so a second statement on
 * the same line cannot ride along. Consequences, all intended: `??=`, `||=`,
 * `Reflect.set`, `Object.defineProperty`, `Object.assign`, `os.Setenv`,
 * `unset`, `env -u`, `delete`, `valueFrom`, a `["NAME","0"]` tuple and even a
 * `const K = "NAME"` (which is what a computed key needs) are all unknown
 * shapes and red.
 *
 * Skipped: `node_modules`, build output, `.claude`, `docs/` and
 * `apps/docs/content` (user-facing prose that documents the `=0` opt-out), any
 * `*.md`/`*.mdx` (prose — it cannot execute) and test FILES (`*.test.*`, which
 * set `0` on purpose; never a whole `__tests__` directory).
 * Comments are stripped before matching, and ONLY where the syntax is known: JS/
 * TS/Go via the quote-aware `scrub`, `#` full-line comments for Dockerfile /
 * yaml / sh / .env. An unrecognised file type strips nothing, so a mention in
 * its comment fails closed rather than passing.
 *
 * REAL LIMITS: the name split across a string concatenation
 * (`"VINEXT_NEXT_" + "DEPLOY_CACHE_CONTROL"`) never appears whole, so it is
 * invisible; a JS regex literal holding a quote can desync `scrub`; and the
 * scan proves no repo file overrides the switch, not that a deployer's
 * cluster does not.
 *
 * `isBunEntryWired` accepts one shape: inside the exported config, a
 * `nitro({ ... })` call whose own top-level `entry:` is the literal
 * `'./knext-bun-entry.mjs'` (optionally as the else-branch of a ternary whose
 * other branch is `'./knext-node-entry.mjs'`), or that same literal in a
 * conditional spread `...(cond ? { entry: '…' } : {})` at nitro's top level. Strings are blanked first, so
 * `note: "entry: './knext-bun-entry.mjs'"` is text; an object outside
 * `export default`, one nested deeper than the `nitro(` argument, or one in a
 * comment does not count. Limit: a `nitro({ entry })` that is built inside the
 * export but never put in `plugins` still counts.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const NAME = "VINEXT_NEXT_DEPLOY_CACHE_CONTROL";
const REPO = join(__dirname, "..", "..", "..", "..");
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".claude",
    ".next",
    ".output",
    "dist",
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
        else if (!/\.test\.[cm]?[tj]sx?$/.test(name) && !/\.md$/.test(name))
            out.push(p);
    }
    return out;
}

/**
 * Remove comments and (optionally) blank string/template contents, keeping
 * newlines so line numbers survive. Quote-aware: a comment opener inside a string
 * is text, and a quote inside a comment is text. A string whose content matches
 * `keep` is left intact (used to keep the entry-path literals).
 */
export function scrub(
    src: string,
    blankStrings: boolean,
    keep?: RegExp,
): string {
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
            let raw = "";
            let j = i + 1;
            while (j < src.length && src[j] !== c) {
                if (src[j] === "\\") {
                    raw += src[j];
                    j++;
                }
                raw += src[j] ?? "";
                j++;
            }
            const blank = blankStrings && !(keep?.test(raw) ?? false);
            out += c + (blank ? raw.replace(/[^\n]/g, " ") : raw) + c;
            i = j + 1;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

const CALL = /^applyVinextDeployDefault\(process\.env\);$/m;

const JS_FAMILY = /\.(?:[mc]?[jt]sx?|go)(?:\.\w+)*$/;
const HASH_COMMENT =
    /^(?:Dockerfile|\.env)|\.(?:ya?ml|sh|env|toml)(?:\.\w+)*$/i;

/** Lines of `src` with comments removed where the syntax is known. */
function codeLines(src: string, path: string): string[] {
    const file = basename(path);
    let text = src;
    if (JS_FAMILY.test(file)) {
        // No regex-literal parsing (a `/^https?:\/\//` desyncs any scanner).
        // Fail closed instead: `scrub` keeps line numbering, so a line that
        // mentions the name RAW but not SCRUBBED was eaten as a "comment"; keep
        // its raw text (an unknown form → red) unless it is a pure comment line.
        const raw = src.split("\n");
        text = scrub(src, false)
            .split("\n")
            .map((l, i) =>
                raw[i]?.includes(NAME) &&
                !l.includes(NAME) &&
                !/^\s*(?:\/\/|\/\*|\*|#)/.test(raw[i])
                    ? raw[i]
                    : l,
            )
            .join("\n");
    } else if (HASH_COMMENT.test(file))
        text = src
            .split("\n")
            .map((l) => (/^\s*#/.test(l) ? "" : l))
            .join("\n");
    return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
}

const N = NAME;
const ONE = `["']?1["']?`;
const VALUE_KEY = /^-?\s*["']?(?:value|Value)["']?\s*:/;
const VALUE_ONE = new RegExp(
    `^-?\\s*["']?(?:value|Value)["']?\\s*:\\s*${ONE},?\\}?,?$`,
);
const NAME_KEY = new RegExp(
    `^(-)?\\s*(\\{\\s*)?["']?(?:name|Name)["']?\\s*:\\s*["']?${N}["']?,?$`,
);
const ASSIGN_SAFE = [
    new RegExp(`^(?:(?:ENV|export)\\s+)?${N}=${ONE}(?:\\s*\\\\)?$`),
    new RegExp(`^ENV\\s+${N}\\s+${ONE}(?:\\s*\\\\)?$`),
    new RegExp(`^["']?${N}["']?\\s*:\\s*${ONE},?$`),
    new RegExp(
        `^(?:[\\w$.]*env)(?:\\.${N}|\\[["']${N}["']\\])\\s*=\\s*["']1["'];?$`,
    ),
    new RegExp(`^\\{?\\s*Name:\\s*"${N}",\\s*Value:\\s*"1",?\\s*\\}?,?$`),
    new RegExp(`^\\{?\\s*Value:\\s*"1",\\s*Name:\\s*"${N}",?\\s*\\}?,?$`),
];
/** The only READ shapes, each bound to the file it is legitimate in. */
const READ_SAFE: [RegExp, RegExp][] = [
    [
        /adapters\/response-cache-control\.mjs$/,
        new RegExp(`^if \\(!env \\|\\| env\\.${N} !== undefined\\) return;$`),
    ],
    [
        /__tests__\/fixtures\/vinext-node-app\/app\/api\/cache-probe\/route\.ts$/,
        new RegExp(`^vinextDeploy: process\\.env\\.${N} \\?\\? null,$`),
    ],
];

/**
 * Every line of `src` (a file at `path`) that mentions the switch in a form NOT
 * on the allowlist, printed with its reason. Empty = every mention is known-safe.
 */
export function findUnsafeMentions(src: string, path = "x.txt"): string[] {
    const lines = codeLines(src, path);
    const hits: string[] = [];
    lines.forEach((l, idx) => {
        if (!l.includes(N)) return;
        if (ASSIGN_SAFE.some((re) => re.test(l))) return;
        if (READ_SAFE.some(([f, re]) => f.test(path) && re.test(l))) return;
        if (NAME_KEY.test(l)) {
            // The ITEM is the run of lines from the nearest line opening one
            // (`-` or `{`) to the next line that opens or closes one. It must
            // hold exactly one value key, equal to 1, and no `valueFrom`; a
            // name never borrows a value across an item boundary.
            let start = idx;
            while (start > 0 && !/^[-{]/.test(lines[start])) start--;
            let end = idx + 1;
            while (end < lines.length && !/^[-{}]/.test(lines[end])) end++;
            const item = lines.slice(start, end);
            const values = item.filter((x) => VALUE_KEY.test(x));
            const ok =
                values.length === 1 &&
                VALUE_ONE.test(values[0]) &&
                !item.some((x) => /valueFrom/i.test(x));
            if (ok) return;
            hits.push(`${l}  [name without a single value of exactly 1]`);
            return;
        }
        hits.push(`${l}  [unknown form]`);
    });
    return hits;
}

/**
 * Whether a vite config wires the bun entry: a `nitro({...})` inside
 * `export default` whose own top-level `entry:` is the bun-entry literal.
 */
export function isBunEntryWired(viteSrc: string): boolean {
    const code = scrub(viteSrc, true, /^\.\/knext-(?:bun|node)-entry\.mjs$/);
    const at = code.indexOf("export default");
    if (at < 0) return false;
    // Bracket-match the exported expression: text after it is not the config.
    let e = at + "export default".length;
    let d = 0;
    let opened = false;
    for (; e < code.length; e++) {
        const c = code[e];
        if ("({[".includes(c)) {
            d++;
            opened = true;
        } else if (")}]".includes(c)) d--;
        if (opened && d === 0) {
            if (/^\s*=>/.test(code.slice(e + 1))) continue;
            e++;
            break;
        }
    }
    const exported = code.slice(at, e);
    const re = /(?<![\w$.])nitro\s*\(\s*\{/g;
    for (let m = re.exec(exported); m; m = re.exec(exported)) {
        const start = m.index + m[0].length - 1;
        let depth = 0;
        let top = "";
        const depthAt: number[] = [];
        let end = exported.length;
        for (let i = start; i < exported.length; i++) {
            const c = exported[i];
            if ("{([".includes(c)) {
                depth++;
                if (depth > 1) top += " ";
            } else if ("})]".includes(c)) {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
                top += " ";
            } else top += depth === 1 ? c : " ";
            depthAt[i - start] = depth;
        }
        if (
            /(?:^|[\s,])entry\s*:\s*(?:onNode\s*\?\s*['"]\.\/knext-node-entry\.mjs['"]\s*:\s*)?['"]\.\/knext-bun-entry\.mjs['"]\s*(?:,|$)/.test(
                top,
            )
        )
            return true;
        // `...(cond ? { entry: '<bun>' } : {})` — a conditional spread that is
        // itself a top-level member of nitro's argument.
        const body = exported.slice(start, end);
        const spread =
            /\.\.\.\(\s*\w+\s*\?\s*\{\s*entry\s*:\s*['"]\.\/knext-bun-entry\.mjs['"]\s*,?\s*\}\s*:\s*\{\s*\}\s*\)/g;
        for (let sm = spread.exec(body); sm; sm = spread.exec(body))
            if (depthAt[sm.index] === 1) return true;
    }
    return false;
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

    // [path, source]. Each is a way to leave the switch off (or unknowable).
    const BAD: [string, string][] = [
        ["Dockerfile", `ENV ${NAME}=0`],
        ["Dockerfile", `ENV ${NAME} 0`],
        ["Dockerfile", `ENV ${NAME}=`],
        ["Dockerfile", `ENV ${NAME}`],
        ["Dockerfile", `ENV ${NAME} "0"`],
        ["Dockerfile", `ENV A=1 \\\n  ${NAME}=0`],
        ["x.sh", `${NAME}=0 node x`],
        ["x.env", `${NAME}=`],
        ["x.yaml", `  ${NAME}: "0"`],
        ["x.sh", `RUN unset ${NAME}`],
        ["x.sh", `RUN env -u ${NAME} node x`],
        ["x.sh", `RUN env --unset=${NAME} node x`],
        ["x.mjs", `delete process.env.${NAME};`],
        ["x.mjs", `process.env["${NAME}"] = "0";`],
        ["x.json", `{"${NAME}": "0"}`],
        ["x.yaml", `- name: ${NAME}\n  value: "0"`],
        ["x.yaml", `- value: "0"\n  name: ${NAME}`],
        ["x.go", `{Name: "${NAME}", Value: "0"}`],
        ["x.go", `{\n  Name:  "${NAME}",\n  Value: "0",\n}`],
        ["x.go", `{Value: "", Name: "${NAME}"}`],
        // round-3 reviewer inputs
        ["x.mjs", `process.env.${NAME} ??= "0";`],
        ["x.mjs", `process.env.${NAME} ||= "0";`],
        ["x.mjs", `Reflect.set(process.env, "${NAME}", "0");`],
        [
            "x.mjs",
            `Object.defineProperty(process.env, "${NAME}", { value: "0" });`,
        ],
        ["x.mjs", `Object.assign(process.env, { ${NAME}: "0" });`],
        ["x.mjs", `const pairs = ["${NAME}", "0"];`],
        ["x.mjs", `/* opt out */ process.env.${NAME} = "0";`],
        ["x.mjs", `const K = "${NAME}";\nprocess.env[K] = "0";`],
        ["x.go", `os.Setenv("${NAME}", "0")`],
        ["x.yaml", `- name: ${NAME}\n  # opt out\n  value: "0"`],
        [
            "x.yaml",
            `- name: ${NAME}\n  valueFrom:\n    configMapKeyRef:\n      name: c`,
        ],
        ["x.yaml", `- name: ${NAME}`],
        ["x.mjs", `env.${NAME} = "1"; env.${NAME} = "0";`],
        ["x.yaml", `- name: ${NAME}\n  value: "1"\n  value: "0"`],
        // round-4 reviewer inputs
        ["x.mjs", `const re = /^https?:\\/\\//; process.env.${NAME} = "0";`],
        [
            "x.mjs",
            `const q = /'/; const u = 'http://x'; process.env.${NAME} = "0";`,
        ],
        [
            "x.yaml",
            `env:\n- value: "0"\n  valueFrom: null\n  name: ${NAME}\n- value: "1"\n  name: OTHER`,
        ],
        [
            "x.yaml",
            `- name: ${NAME}\n  value: "1"\n  valueFrom: null\n  value: "0"`,
        ],
        ["x.yaml", `- name: ${NAME}\n  value: "1"\n  x: y\n  value: "0"`],
        // a block-comment INTERIOR line without a leading `*` is not pure comment
        ["x.mjs", `/*\n process.env.${NAME} = "0";\n*/`],
        // an ambiguous neighbour on both sides is refused
        ["x.yaml", `value: "1"\nname: ${NAME}\nvalue: "1"`],
        // unrecognised file type: comments are not stripped, so a mention fails
        ["x.txt", `# ${NAME}=0 documents the opt-out`],
        // the read shapes are bound to their own files
        ["src/other.mjs", `if (!env || env.${NAME} !== undefined) return;`],
    ];
    for (const [path, b] of BAD) {
        it(`flags: ${path} ${JSON.stringify(b)}`, () => {
            expect(findUnsafeMentions(b, path)).not.toEqual([]);
        });
    }

    const GOOD: [string, string][] = [
        ["Dockerfile", `ENV ${NAME}=1`],
        ["Dockerfile", `ENV ${NAME}=1 \\`],
        ["Dockerfile", `ENV ${NAME} 1`],
        ["Dockerfile", `ENV ${NAME} "1"`],
        ["x.sh", `export ${NAME}=1`],
        ["x.yaml", `  ${NAME}: "1"`],
        ["x.yaml", `- name: ${NAME}\n  value: "1"`],
        ["x.yaml", `- name: ${NAME}\n  # note\n  value: "1"`],
        ["x.yaml", `- value: "1"\n  name: ${NAME}`],
        ["x.mjs", `env.${NAME} = "1";`],
        ["x.mjs", `process.env["${NAME}"] = "1";`],
        ["x.go", `{Name: "${NAME}", Value: "1"}`],
        ["x.go", `{\n  Name:  "${NAME}",\n  Value: "1",\n}`],
        ["Dockerfile", `# ${NAME}=0 documents the opt-out`],
        ["x.mjs", `// ${NAME}=0 documents the opt-out\nx();`],
        ["x.mjs", `/*\n * process.env.${NAME} = "0";\n */`],
        [
            "packages/kn-next/src/adapters/response-cache-control.mjs",
            `if (!env || env.${NAME} !== undefined) return;`,
        ],
        [
            "packages/kn-next/src/__tests__/fixtures/vinext-node-app/app/api/cache-probe/route.ts",
            `vinextDeploy: process.env.${NAME} ?? null,`,
        ],
    ];
    for (const [path, g] of GOOD) {
        it(`allows: ${path} ${JSON.stringify(g)}`, () => {
            expect(findUnsafeMentions(g, path)).toEqual([]);
        });
    }
});

describe("bun-entry wiring fixture", () => {
    const wrap = (nitroArg: string, before = "") =>
        `${before}\nexport default defineConfig({ plugins: [nitro(${nitroArg})] });`;
    const NOT_WIRED: [string, string][] = [
        [
            "a dead nitro() AFTER the export",
            `export default defineConfig({ plugins: [nitro({ entry: './other.mjs' })] });\nconst dead = nitro({ entry: './knext-bun-entry.mjs' });`,
        ],
        [
            "a member call named nitro",
            wrap(`{ entry: './knext-bun-entry.mjs' }`).replace(
                "nitro(",
                "foo.nitro(",
            ),
        ],
        [
            "a ternary on some other condition",
            wrap(
                `{ entry: c ? './knext-node-entry.mjs' : './knext-bun-entry.mjs' }`,
            ),
        ],
        [
            "renamed entry + trailing comment",
            "export default nitro({ preset: 'bun', entry: './other.mjs' }) // knext-bun-entry",
        ],
        [
            "only in a block comment",
            "/* entry: './knext-bun-entry.mjs' */ export default x",
        ],
        [
            "the other key's string mentions it",
            wrap(
                `{ entry: './other.mjs', note: "entry: './knext-bun-entry.mjs'" }`,
            ),
        ],
        [
            "a nitro call BEFORE the export",
            `const p = nitro({ entry: './knext-bun-entry.mjs' });\nexport default defineConfig({ plugins: [] });`,
        ],
        [
            "a string that spells the whole property",
            wrap(
                `{ entry: './other.mjs', note: " entry: './knext-bun-entry.mjs', " }`,
            ),
        ],
        [
            "an unused object before the export",
            wrap(
                `{ entry: './other.mjs' }`,
                `const unused = { entry: './knext-bun-entry.mjs' };`,
            ),
        ],
        [
            "an object in the export that is not nitro's argument",
            `export default defineConfig({ plugins: [], other: { entry: './knext-bun-entry.mjs' } });`,
        ],
        [
            "nested deeper than nitro's own object",
            wrap(`{ opts: { entry: './knext-bun-entry.mjs' } }`),
        ],
        [
            "a conditional spread nested deeper than nitro's own object",
            wrap(
                `{ opts: { ...(c ? { entry: './knext-bun-entry.mjs' } : {}) } }`,
            ),
        ],
        ["the node entry only", wrap(`{ entry: './knext-node-entry.mjs' }`)],
    ];
    for (const [why, src] of NOT_WIRED) {
        it(`is NOT wired: ${why}`, () => {
            expect(isBunEntryWired(src)).toBe(false);
        });
    }
    it("is wired: the conditional spread the docs app uses", () => {
        expect(
            isBunEntryWired(
                wrap(
                    `{ preset, ...(usesBunEntry ? { entry: './knext-bun-entry.mjs' } : {}), x: 1 }`,
                ),
            ),
        ).toBe(true);
    });
    it("is wired: a plain entry, and the runtime ternary the template uses", () => {
        expect(
            isBunEntryWired(
                wrap(`{ preset: 'bun', entry: './knext-bun-entry.mjs' }`),
            ),
        ).toBe(true);
        expect(
            isBunEntryWired(
                wrap(
                    `{ entry: onNode ? './knext-node-entry.mjs' : './knext-bun-entry.mjs', x: 1 }`,
                ),
            ),
        ).toBe(true);
    });
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
            if (!name) throw new Error(`${id} does not resolve to a module`);
            return join(REPO, "packages/kn-next/src/adapters", `${name}.mjs`);
        });
    }

    for (const f of entries) {
        it(`${rel(f)} is guarded`, () => {
            const code = readCode(f);
            const raw = readFileSync(f, "utf8");
            const viaNode = /srvx\/node/.test(raw);
            const viaBun = /srvx\/bun/.test(raw) || /Bun\.serve/.test(raw);
            if (!(viaNode || viaBun)) {
                throw new Error(
                    `${rel(f)}: unclassified entry (serves through neither srvx/node nor srvx/bun)`,
                );
            }
            if (viaNode) {
                expect(code).toMatch(CALL);
            }
            if (viaBun) {
                // Compiled through vinext-compile: some vite.config* next to the
                // entry (or the scaffolder template) must wire it in...
                const dir = dirname(f);
                const wired = readdirSync(dir)
                    .filter((n) => /^vite\.config\.m?[jt]s(?:\.hbs)?$/.test(n))
                    .some((n) =>
                        isBunEntryWired(readFileSync(join(dir, n), "utf8")),
                    );
                if (!wired) {
                    throw new Error(
                        `${rel(f)} is not wired into a vite.config*`,
                    );
                }
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

    it("every mention of the switch in the repo is a known-safe form", () => {
        const bad: string[] = [];
        for (const f of FILES) {
            let src: string;
            try {
                src = readFileSync(f, "utf8");
            } catch {
                continue;
            }
            if (!src.includes(NAME)) continue;
            for (const h of findUnsafeMentions(src, rel(f)))
                bad.push(`${rel(f)}: ${h}`);
        }
        expect(bad).toEqual([]);
    });
});
