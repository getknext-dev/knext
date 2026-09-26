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
 * NO HAND-ROLLED LEXER. Six rounds of hand-written comment/string scrubbing each
 * leaked (regex literals, nested backticks, `*` continuation lines...). Source
 * is now read by real parsers:
 *   - JS/TS (`.js .mjs .cjs .ts .mts .cts .jsx .tsx`, also under `.hbs`): the
 *     file goes through `Bun.Transpiler`; the OUTPUT (comments removed by Bun's
 *     own lexer; strings and template literals kept as code) is checked line by
 *     line. A parse error is red ("unparseable JS"). There are no comment
 *     exemptions at all.
 *   - YAML (`.yaml .yml`): parsed with the `yaml` package (duplicate keys and
 *     parse errors are red) and the document walked — see `yamlHits`.
 *   - everything else (Dockerfile, sh, .env, json, Go, `.hbs`, unknown): every
 *     line that mentions the name must be an exact safe form. A full-line `#` or
 *     `//` comment is skipped only when the ENTIRE line is a comment (starts with
 *     the marker and contains none of `= ( :`).
 *
 * THE OVERRIDE SCAN IS AN ALLOWLIST. Every non-test line that mentions the
 * variable must match a KNOWN-SAFE form, else it is red with the line printed:
 *   - assignment of the literal `1`: `NAME=1`, `ENV NAME=1`, `ENV NAME 1`,
 *     `export NAME=1`, `NAME: "1"`, `env.NAME = "1"` / `process.env["NAME"] = "1"`;
 *   - the Go one-line struct `{Name: "NAME", Value: "1"}` (either order);
 *   - two READ shapes, each bound to its own file: the early-return guard in
 *     `adapters/response-cache-control.mjs` and the fixture probe
 *     `process.env.NAME ?? null`;
 *   - in YAML, a mapping `{name: NAME, value: "1"|1}` with no `valueFrom`, or a
 *     key `NAME` whose value is `"1"|1`.
 * So `??=`, `||=`, `Reflect.set`, `Object.defineProperty`, `Object.assign`,
 * `os.Setenv`, `unset`, `env -u`, `delete`, `valueFrom`, tuples, `const K =
 * "NAME"`, and a multi-line Go struct (write it on one line) are all red.
 *
 * Skipped: `node_modules`, build output, `.claude`, `docs/` and
 * `apps/docs/content` (user-facing prose that documents the `=0` opt-out), any
 * `*.md` (prose — it cannot execute) and test FILES (`*.test.*`, which set `0`
 * on purpose; never a whole `__tests__` directory).
 *
 * YAML is parsed with `merge: true` (`<<` keys applied, as kubectl/compose do) and
 * the `failsafe` schema, so a scalar is its SOURCE text: `1.0`, `0x1`, `01` are
 * not `1`. A parse error or an unresolvable alias is red.
 *
 * Every file is looked at, but first pre-filtered on a LOOSE text: escapes
 * decoded (`\xHH`, `\uHHHH`, `\u{H}`, octal), then every backslash and
 * backslash-newline continuation removed (`\_`, string line-continuations), so the
 * filter is more permissive than any decoder downstream and an escaped spelling
 * of the name is not skipped. In JS the transpiler decodes it; in other file types an escaped
 * spelling is red outright. A parse error in a file that never names the switch
 * is irrelevant and ignored.
 *
 * REAL LIMITS: the name never appearing whole is invisible when it is built by
 * string concatenation (`"VINEXT_NEXT_" + "DEPLOY_CACHE_CONTROL"`), split by a
 * shell/Dockerfile backslash-newline, or assembled by a JSON-driven script.
 * The scan proves no repo file overrides the switch, not that a deployer's
 * cluster does not; a `/*!` legal comment is preserved by the
 * transpiler and so is red, not skipped.
 *
 * `isBunEntryWired` accepts one shape: inside the exported config, a
 * `nitro({ ... })` call whose own top-level `entry:` is the literal
 * `'./knext-bun-entry.mjs'` (optionally the else-branch of `onNode ? node : bun`),
 * or that literal in a conditional spread `...(cond ? { entry: '…' } : {})` at
 * nitro's top level. The file is transpiled first (comments gone), then string
 * contents are blanked (except the entry paths) so `note: "entry: '…'"` is text.
 * Limits: a `nitro({ entry })` built inside the export but never put in
 * `plugins` still counts; a duplicate `entry:` key counts if either is the bun
 * literal (at runtime the last key wins); the string blanker does not parse regex
 * literals (a quote inside one can desync it — that fails toward "not wired" on
 * every real config).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseAllDocuments } from "yaml";

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

/** Loader for `Bun.Transpiler` from the file's JS/TS extension (also under `.hbs`), or null. */
function loaderFor(file: string): "js" | "jsx" | "ts" | "tsx" | null {
    const ext = file.match(/\.([mc]?[jt]sx?)(?:\.\w+)*$/)?.[1];
    if (!ext) return null;
    if (ext.endsWith("tsx")) return "tsx";
    if (ext.endsWith("jsx")) return "jsx";
    return ext.includes("t") ? "ts" : "js";
}

/** Transpile with Bun's real lexer: comments gone, strings/templates kept. Throws on a parse error. */
export function transpile(src: string, file: string): string {
    const loader = loaderFor(file);
    if (!loader) throw new Error(`not a JS/TS file: ${file}`);
    return new Bun.Transpiler({ loader }).transformSync(src);
}

/**
 * Blank the contents of string/template literals in ALREADY comment-free code
 * (transpiler output), keeping newlines. A string whose content matches `keep`
 * is left intact. Does not parse regex literals (stated limit).
 */
function blankStringLiterals(code: string, keep?: RegExp): string {
    let out = "";
    let i = 0;
    while (i < code.length) {
        const c = code[i];
        if (c === '"' || c === "'" || c === "`") {
            let raw = "";
            let j = i + 1;
            while (j < code.length && code[j] !== c) {
                if (code[j] === "\\") {
                    raw += code[j];
                    j++;
                }
                raw += code[j] ?? "";
                j++;
            }
            const blank = !(keep?.test(raw) ?? false);
            out += c + (blank ? raw.replace(/[^\n]/g, " ") : raw) + c;
            i = j + 1;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

/** A real vite config file name (not `vite.config.bak.ts`). */
const VITE_CONFIG_NAME = /^vite\.config\.m?[jt]s(?:\.hbs)?$/;

const CALL = /^applyVinextDeployDefault\(process\.env\);$/m;

const N = NAME;
const ONE = `["']?1["']?`;
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
        new RegExp(
            `^if \\(!env \\|\\| env\\.${N} !== undefined\\)(?: return;)?$`,
        ),
    ],
    [
        /__tests__\/fixtures\/vinext-node-app\/app\/api\/cache-probe\/route\.ts$/,
        new RegExp(`^vinextDeploy: process\\.env\\.${N} \\?\\? null,?$`),
    ],
];

/**
 * YAML is parsed with the `failsafe` schema, so every scalar stays its SOURCE
 * text: `1.0`, `0x1`, `01` are not "1" (only `1`, `"1"` and `'1'` are). `merge`
 * applies `<<` keys the way kubectl/compose do.
 */
const isOne = (v: unknown) => v === "1";

/**
 * The pre-filter text: escapes decoded, then EVERY backslash and any
 * backslash-newline continuation removed, so it is strictly more permissive than
 * any decoder downstream (JS treats `\_` as `_` and a backslash-newline in a
 * string as nothing; so do YAML double-quoted scalars and the shell).
 */
function looseText(s: string): string {
    return decodeEscapes(s).replace(/\\(?:\r?\n[ \t]*)?/g, "");
}

/** `\xHH`, `\uHHHH`, `\u{H+}` and octal escapes decoded (for the mention pre-filter). */
function decodeEscapes(s: string): string {
    return s.replace(
        /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]+)\}|([0-7]{1,3}))/g,
        (m, x, u, ub, o) => {
            const cp = x
                ? Number.parseInt(x, 16)
                : u
                  ? Number.parseInt(u, 16)
                  : ub
                    ? Number.parseInt(ub, 16)
                    : Number.parseInt(o, 8);
            return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
        },
    );
}

/** Unsafe mentions in a YAML document: walk the parsed value, not the text. */
function yamlHits(src: string): string[] {
    let docs: ReturnType<typeof parseAllDocuments>;
    try {
        docs = parseAllDocuments(src, { merge: true, schema: "failsafe" });
    } catch (e) {
        return [`unparseable YAML: ${String(e).slice(0, 80)}`];
    }
    const hits: string[] = [];
    const walk = (node: unknown): void => {
        if (typeof node === "string") {
            if (node.includes(N))
                hits.push(`${node}  [bare string mentioning the switch]`);
        } else if (Array.isArray(node)) {
            for (const x of node) walk(x);
        } else if (node && typeof node === "object") {
            const m = node as Record<string, unknown>;
            const named = m.name === N;
            if (named && (!isOne(m.value) || "valueFrom" in m))
                hits.push(
                    `name: ${N} with ${"valueFrom" in m ? "valueFrom" : `value ${JSON.stringify(m.value)}`}  [not exactly 1]`,
                );
            for (const [k, v] of Object.entries(m)) {
                if (k === N) {
                    if (!isOne(v))
                        hits.push(
                            `${N}: ${JSON.stringify(v)}  [not exactly 1]`,
                        );
                    continue;
                }
                if (k.includes(N))
                    hits.push(`${k}  [key mentioning the switch]`);
                if (named && k === "name") continue;
                walk(v);
            }
        }
    };
    for (const d of docs) {
        for (const e of d.errors)
            hits.push(`YAML error: ${e.message.slice(0, 80)}`);
        try {
            walk(d.toJS({ maxAliasCount: -1 }));
        } catch (e) {
            hits.push(`unresolvable YAML: ${String(e).slice(0, 80)}`);
        }
    }
    return hits;
}

/**
 * Every mention of the switch in `src` (a file at `path`) that is NOT a known-
 * safe form, printed with its reason. Empty = every mention is known-safe.
 */
export function findUnsafeMentions(src: string, path = "x.txt"): string[] {
    const file = basename(path);
    // Pre-filter on the DECODED text, so an escaped spelling of the name is
    // still looked at. A file that never names the switch cannot override it,
    // so a parse error there is irrelevant.
    const norm = looseText(src);
    if (!norm.includes(N)) return [];
    let lines: string[];
    if (loaderFor(file)) {
        try {
            lines = transpile(src, file).split("\n");
        } catch (e) {
            return [`unparseable JS (${file}): ${String(e).slice(0, 80)}`];
        }
    } else if (/\.ya?ml$/i.test(file)) {
        return yamlHits(src);
    } else {
        // Any spelling the loose pre-filter sees that the exact-line check
        // below cannot (escapes, `\_`, backslash-newline) is red outright —
        // including one that sits next to a legitimate literal mention.
        if (norm.split(N).length !== src.split(N).length)
            return [`${file}  [escaped spelling of the switch name]`];
        // Only a line that is ENTIRELY a comment is skipped.
        lines = src
            .split("\n")
            .filter((l) => !(/^\s*(?:#|\/\/)/.test(l) && !/[=(:]/.test(l)));
    }
    const hits: string[] = [];
    for (const raw of lines) {
        const l = raw.trim();
        if (!l.includes(N)) continue;
        if (ASSIGN_SAFE.some((re) => re.test(l))) continue;
        if (READ_SAFE.some(([f, re]) => f.test(path) && re.test(l))) continue;
        hits.push(`${l}  [unknown form]`);
    }
    return hits;
}

/**
 * Whether a vite config wires the bun entry: a `nitro({...})` inside
 * `export default` whose own top-level `entry:` is the bun-entry literal.
 */
export function isBunEntryWired(viteSrc: string): boolean {
    let transpiled: string;
    try {
        transpiled = transpile(viteSrc, "vite.config.ts");
    } catch {
        return false;
    }
    const code = blankStringLiterals(
        transpiled,
        /^\.\/knext-(?:bun|node)-entry\.mjs$/,
    );
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
            /\.\.\.\(?\s*\w+\s*\?\s*\{\s*entry\s*:\s*['"]\.\/knext-bun-entry\.mjs['"]\s*,?\s*\}\s*:\s*\{\s*\}\s*\)?/g;
        for (let sm = spread.exec(body); sm; sm = spread.exec(body))
            if (depthAt[sm.index] === 1) return true;
    }
    return false;
}

const FILES = walk(REPO);
const rel = (p: string) => relative(REPO, p);
const readCode = (p: string) =>
    blankStringLiterals(transpile(readFileSync(p, "utf8"), basename(p)));

describe("scanner fixtures (each form must be caught, each safe form must not)", () => {
    it("the transpiler strips comments and keeps strings: a call in a template literal is not code", () => {
        const src = "const s = `\napplyVinextDeployDefault(process.env);\n`;\n";
        expect(blankStringLiterals(transpile(src, "x.mjs"))).not.toMatch(CALL);
        expect(
            blankStringLiterals(
                transpile("applyVinextDeployDefault(process.env);\n", "x.mjs"),
            ),
        ).toMatch(CALL);
        expect(
            blankStringLiterals(
                transpile(
                    "/* applyVinextDeployDefault(process.env);\n*/\nx();",
                    "x.mjs",
                ),
            ),
        ).not.toMatch(CALL);
    });

    it("an unparseable JS file is red, never skipped", () => {
        expect(
            findUnsafeMentions(`const = ;\n// ${NAME}`, "x.mjs"),
        ).not.toEqual([]);
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
        ["x.sh", `RUN unset ${NAME}`],
        ["x.sh", `RUN env -u ${NAME} node x`],
        ["x.sh", `RUN env --unset=${NAME} node x`],
        ["x.json", `{"${NAME}": "0"}`],
        ["x.mjs", `delete process.env.${NAME};`],
        ["x.mjs", `process.env["${NAME}"] = "0";`],
        ["x.go", `{Name: "${NAME}", Value: "0"}`],
        ["x.go", `{Value: "", Name: "${NAME}"}`],
        ["x.go", `os.Setenv("${NAME}", "0")`],
        // a multi-line Go struct is unsupported by design (write it on one line)
        ["x.go", `{\n  Name:  "${NAME}",\n  Value: "0",\n}`],
        ["x.go", `{\n  Name:  "${NAME}",\n  Value: "1",\n}`],
        // YAML: parsed, then walked
        ["x.yaml", `  ${NAME}: "0"`],
        ["x.yaml", `- name: ${NAME}\n  value: "0"`],
        ["x.yaml", `- value: "0"\n  name: ${NAME}`],
        ["x.yaml", `- name: ${NAME}\n  # opt out\n  value: "0"`],
        [
            "x.yaml",
            `- name: ${NAME}\n  valueFrom:\n    configMapKeyRef:\n      name: c`,
        ],
        ["x.yaml", `- name: ${NAME}\n  value: "1"\n  valueFrom: {}`],
        ["x.yaml", `- name: ${NAME}`],
        ["x.yaml", `env:\n  - name: ${NAME}\nother:\n  value: "1"`],
        [
            "x.yaml",
            `env:\n- value: "0"\n  valueFrom: null\n  name: ${NAME}\n- value: "1"\n  name: OTHER`,
        ],
        // duplicate keys are a parse error, so red whichever comes last
        ["x.yaml", `- name: ${NAME}\n  value: "0"\n  value: "1"`],
        ["x.yaml", `- name: ${NAME}\n  value: "1"\n  value: "0"`],
        ["x.yaml", `args: ["unset ${NAME}"]`],
        ["x.yaml", `- {{ broken ${NAME}`],
        // merge keys are applied (kubectl/compose do), so the effective value is 0
        [
            "x.yaml",
            `base: &b\n  name: ${NAME}\n  value: "1"\nspec:\n  env:\n  - <<: *b\n    value: "0"`,
        ],
        [
            "x.yaml",
            `base: &b {name: ${NAME}, value: "1"}\nspec:\n  env:\n  - {<<: *b, value: "0"}`,
        ],
        // an alias that does not resolve cannot be judged: red
        ["x.yaml", `- {<<: *nope, name: ${NAME}, value: "1"}`],
        // only the literal scalar 1 is 1
        ["x.yaml", `- name: ${NAME}\n  value: 1.0`],
        ["x.yaml", `- name: ${NAME}\n  value: 0x1`],
        ["x.yaml", `- name: ${NAME}\n  value: 01`],
        // identity escapes and backslash-newline continuations (round-8 inputs)
        ["x.mjs", `process.env["VINEXT\\_NEXT_DEPLOY_CACHE_CONTROL"] = "0";`],
        ["x.mjs", `process.env[\`VINEXT\\_NEXT_DEPLOY_CACHE_CONTROL\`] = "0";`],
        ["x.mjs", `process.env["VINEXT_NEXT_\\\nDEPLOY_CACHE_CONTROL"] = "0";`],
        [
            "x.yaml",
            `- name: "VINEXT_NEXT_\\\n    DEPLOY_CACHE_CONTROL"\n  value: "0"`,
        ],
        ["x.sh", `export VINEXT\\_NEXT_DEPLOY_CACHE_CONTROL=0`],
        // ...also next to a legitimate literal mention in the same file
        [
            "Dockerfile",
            `ENV ${NAME}=1\nENV VINEXT\\_NEXT_DEPLOY_CACHE_CONTROL=0`,
        ],
        // an escaped spelling of the name is decoded before the pre-filter
        ["x.mjs", `process.env["VINEXT\\x5fNEXT_DEPLOY_CACHE_CONTROL"] = "0";`],
        [
            "x.mjs",
            `process.env["VINEXT\\u005fNEXT_DEPLOY_CACHE_CONTROL"] = "0";`,
        ],
        [
            "x.mjs",
            `process.env["VINEXT\\u{5f}NEXT_DEPLOY_CACHE_CONTROL"] = "0";`,
        ],
        ["x.json", `{"VINEXT\\u005fNEXT_DEPLOY_CACHE_CONTROL": "0"}`],
        // JS: real lexer, allowlist on the output
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
        ["x.mjs", `env.${NAME} = "1"; env.${NAME} = "0";`],
        ["x.mjs", `/*! ${NAME}=0 */\nx();`],
        // round-3 .. round-5 desync inputs (a real lexer does not desync)
        ["x.mjs", `const re = /^https?:\\/\\//; process.env.${NAME} = "0";`],
        [
            "x.mjs",
            `const q = /'/; const u = 'http://x'; process.env.${NAME} = "0";`,
        ],
        ["x.mjs", `/* c */ const r = /\\/\\//; process.env.${NAME} = "0";`],
        [
            "x.mjs",
            `const r = /x\\/*/;\n  const y = 2\n  * 2; process.env.${NAME} = "0";`,
        ],
        [
            "x.mjs",
            `class A { #r = /\\/\\//; x = (process.env.${NAME} = "0"); }`,
        ],
        ["x.mjs", `/* c */ Reflect.set(process.env, \`${NAME}\`, "0");`],
        // round-6 reviewer input: a nested quoted backtick / `"a/*b"` string
        // and a multiplication continuation carrying a tagged template
        [
            "x.mjs",
            `const s = "a/*b"; const x = 2\n  * Reflect.set(process.env, String.raw\`${NAME}\`, "0");`,
        ],
        // the read shapes are bound to their own files
        ["src/other.mjs", `if (!env || env.${NAME} !== undefined) return;`],
        // unrecognised type: a comment containing `=` is not "entirely a comment"
        ["x.txt", `# ${NAME}=0 documents the opt-out`],
        ["Dockerfile", `# ${NAME}=0 documents the opt-out`],
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
        ["x.go", `{Name: "${NAME}", Value: "1"}`],
        ["x.yaml", `  ${NAME}: "1"`],
        ["x.yaml", `- name: ${NAME}\n  value: "1"`],
        ["x.yaml", `- name: ${NAME}\n  value: 1`],
        ["x.yaml", `- name: ${NAME}\n  # note\n  value: "1"`],
        ["x.yaml", `- value: "1"\n  name: ${NAME}`],
        [
            "x.yaml",
            `env:\n  - name: ${NAME}\n    value: "1"\nother:\n  value: "0"`,
        ],
        [
            "x.yaml",
            `- name: ${NAME}\n  value: "1"\n- name: OTHER\n  value: "0"`,
        ],
        [
            "x.yaml",
            `- name: OTHER\n  value: "0"\n- name: ${NAME}\n  value: "1"`,
        ],
        ["x.yaml", `# ${NAME}=0 documents the opt-out\nx: 1`],
        ["x.mjs", `env.${NAME} = "1";`],
        ["x.mjs", `process.env["${NAME}"] = "1";`],
        // comments are stripped by the real lexer — however they are shaped
        ["x.mjs", `// ${NAME}=0 documents the opt-out\nx();`],
        ["x.mjs", `/*\n process.env.${NAME} = "0";\n*/`],
        ["x.mjs", `/*\n * process.env.${NAME} = "0";\n */`],
        ["x.mjs", `/**\n * page) when \`${NAME}=1\`; it reads it.\n */`],
        ["x.mjs", `/* the switch \`${NAME}\` is documented here */`],
        ["x.mjs", `const s = "a/*b"; x();\n// ${NAME}=0`],
        [
            "packages/kn-next/src/adapters/response-cache-control.mjs",
            `if (!env || env.${NAME} !== undefined) return;`,
        ],
        [
            "packages/kn-next/src/__tests__/fixtures/vinext-node-app/app/api/cache-probe/route.ts",
            `const a = { vinextDeploy: process.env.${NAME} ?? null };`.replace(
                "const a = { ",
                "const a = {\n",
            ),
        ],
        ["Dockerfile", `# ${NAME} opt-out is documented elsewhere`],
    ];
    for (const [path, g] of GOOD) {
        it(`allows: ${path} ${JSON.stringify(g)}`, () => {
            expect(findUnsafeMentions(g, path)).toEqual([]);
        });
    }
});

describe("vite config file names", () => {
    it("accepts real configs and the template, rejects backups and lookalikes", () => {
        for (const n of [
            "vite.config.ts",
            "vite.config.mjs",
            "vite.config.ts.hbs",
        ])
            expect(VITE_CONFIG_NAME.test(n)).toBe(true);
        for (const n of [
            "vite.config.bak.ts",
            "vite.config.ts.bak",
            "vite.config.d.ts",
        ])
            expect(VITE_CONFIG_NAME.test(n)).toBe(false);
    });
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
    const compileCode = transpile(compile, "vinext-compile.mjs");

    /** Modules the compile step imports ahead of the entry. */
    function injectedInstallModules(): string[] {
        const ids = [
            ...compileCode.matchAll(/`import \$\{JSON\.stringify\((\w+)\)\};/g),
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
                    .filter((n) => VITE_CONFIG_NAME.test(n))
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
            for (const h of findUnsafeMentions(src, rel(f)))
                bad.push(`${rel(f)}: ${h}`);
        }
        expect(bad).toEqual([]);
    });
});
