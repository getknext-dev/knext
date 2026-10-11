/**
 * Guard: no user-facing string tells the user to run `kn-next`.
 *
 * The `kn-next` bin is gone; `knext` is the only command. Anything the
 * product shows or ships to a user -- CLI output, generated files, scaffold
 * templates, the GitHub Action, the docs -- must name `knext`.
 *
 * SCANNING, not enumerating: every file under the shipped surfaces is read
 * and matched against a command-form pattern, so a new string added later is
 * caught without anyone remembering to list it. The CLI itself is also RUN
 * (`--help`, every verb's `--help`) and its real stdout/stderr scanned.
 *
 * Command form = `kn-next` used as a command: `npx|bunx|pnpm dlx kn-next`,
 * `.bin/kn-next`, or `kn-next <verb|flag>`. File names, package names and
 * paths (`kn-next.config.ts`, `kn-next-operator`, `packages/kn-next/`,
 * `dist/cli/kn-next.js`) are not commands and do not match.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(
    fileURLToPath(import.meta.url),
    "..",
    "..",
    "..",
    "..",
    "..",
);
const PKG = join(REPO_ROOT, "packages", "kn-next");

/** A `kn-next` that is not part of a longer identifier, path or file name. */
const BARE = String.raw`(?<![\w/@.\-])kn-next(?![\w.\-/@])`;
/** npx/bunx options: `--package <pkg>`, `--package=<pkg>`, `-p <pkg>`, then plain flags. */
const RUNNER_OPTS = String.raw`(?:\s+(?:--package[= ]\S+|-p\s+\S+|-{1,2}[\w-]+))*`;
export const COMMAND_FORM = new RegExp(
    [
        String.raw`\b(?:npx|bunx|pnpx|dlx|exec)${RUNNER_OPTS}\s+${BARE}`,
        String.raw`\.bin/kn-next\b`,
        // argv arrays and compose/k8s `command:` lists:
        //   ["kn-next", "db"]  ['kn-next','db']  command: kn-next
        String.raw`[\[,]\s*['"]kn-next['"]\s*[,\]]`,
        String.raw`\bcommand:\s*['"]?kn-next\b`,
        // the command word named in code font: "installs the `kn-next` command"
        "`kn-next`",
        // imperative prose: "run kn-next from here"
        String.raw`\b(?:run|runs|running|use|using|type|invoke|call)\s+${BARE}`,
        // `kn-next <verb>` / `kn-next --flag`, but not prose such as
        // "kn-next is ..." -- see PROSE_STOPWORDS below.
        String.raw`${BARE}\s+(?:--?[a-z]|[a-z][\w-]*)`,
    ].join("|"),
    "g",
);
const PROSE_STOPWORDS = new Set([
    "integrates",
    "is",
    "was",
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "in",
    "of",
    "for",
    "on",
    "as",
    "at",
    "by",
    "with",
    "from",
    "has",
    "had",
    "will",
    "can",
    "does",
    "did",
    "uses",
    "runs",
    "ships",
    "binds",
    "no",
    "not",
    "now",
    "alias",
    "package",
    "framework",
    "cli",
    "config",
    "operator",
    "standalone",
    "runtime",
    "adapter",
    "version",
    "name",
    "bin",
]);

/**
 * Join what a reader sees as ONE line: shell continuations, single newlines
 * inside a paragraph / comment block / blockquote (dropping the leading comment
 * or quote marker), and string-literal concatenation across lines. A blank line
 * still ends a paragraph.
 */
export function logicalText(text: string): string {
    return text
        .replace(/\\\r?\n/g, " ")
        .replace(/["'`][ \t]*\+[ \t]*\r?\n[ \t]*["'`]/g, "")
        .replace(
            /[ \t]*\r?\n(?![ \t]*\r?\n)[ \t]*(?:\/\*+|\/\/+|\*+(?!\/)|#+|>+)?[ \t]*/g,
            " ",
        );
}

/**
 * The package NAME is `kn-next` (the forwarding alias) or `@getknext/core`; there is
 * no npm package called `knext`, so telling a user to view, install or publish it
 * is wrong. A rename of the command must not rename the package in these lines.
 */
export const PACKAGE_NAME_MISTAKE =
    /\bnpm\s+(?:view|info|install|i|add|publish|dist-tag\s+add|deprecate)\s+knext\b/g;

export function commandHits(text: string): string[] {
    const hits: string[] = [];
    const flat = logicalText(text);
    for (const m of flat.matchAll(COMMAND_FORM)) {
        // Prose filter only applies to the bare `kn-next <word>` branch.
        const bare = /^kn-next\s+([a-z][\w-]*)/.exec(m[0]);
        if (bare && PROSE_STOPWORDS.has(bare[1])) continue;
        const at = m.index ?? 0;
        hits.push(flat.slice(Math.max(0, at - 40), at + 80).trim());
    }
    for (const m of flat.matchAll(PACKAGE_NAME_MISTAKE)) {
        const at = m.index ?? 0;
        hits.push(flat.slice(Math.max(0, at - 40), at + 80).trim());
    }
    return hits;
}

/** `//` and block comments in real source are developer text, not output. */
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|go)$/;
function stripCodeComments(text: string): string {
    return text
        .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Everything tracked is user-facing unless it is history, tooling or tests.
 * The allowlist is reviewed: each entry says why a `kn-next` mention is fine.
 */
const NOT_GUIDANCE: Array<[RegExp, string]> = [
    [
        /^docs\/(adr|benchmarks|release|ux|verification|incidents|spikes|wayfinder|testing)\//,
        "decision, measurement, release and incident history",
    ],
    [/^docs\/(SPRINT_1|SPRINT_2|V1_ROADMAP)\.md$/, "dated planning records"],
    [
        /^docs\/COMPATIBILITY\.md$/,
        "names the kn-next npm package (the forwarding alias), not the command",
    ],
    [/(^|\/)CHANGELOG\.md$/, "changelog"],
    [/^\.changeset\//, "changelog source"],
    [/^\.(claude|agent|github)\//, "agent config and internal CI"],
    [/^(tests|scripts|spikes)\//, "repo tooling, spikes and their fixtures"],
    [/(^|\/)__tests__\//, "tests"],
    [/\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|\/test\//, "tests"],
    [
        /^packages\/kn-next-alias\//,
        "the forwarding package is itself the kn-next name",
    ],
    [
        /^apps\/docs\/content\/docs\/(upgrading|versioning)\.mdx$/,
        "documents that the command is gone",
    ],
    [/^apps\/docs\/_design-reference\//, "static design mock-up"],
    [
        /(^|\/)(bun\.lock|package-lock\.json)$|\.(jsonl|snap|lock|svg|png)$|^graphify-out\//,
        "generated data",
    ],
    [
        /^ROADMAP\.md$|^SECURITY\.md$|^CLAUDE\.md$|^docs\/(MATURITY_PLAN|ROADMAP)\.md$/,
        "maintainer and strategy docs",
    ],
    [
        /^packages\/scale-zero-pg\/(HANDOFF\.md|docs\/knext-research\.md)$/,
        "research notes",
    ],
];
const SCANNED_EXT =
    /\.(ts|tsx|js|mjs|cjs|go|json|ya?ml|md|mdx|sh|hbs|tmpl|txt|html|toml|trivyscan)$|(^|\/)(Dockerfile[\w.-]*|\.gitignore|\.cursorrules|\.geminirules|Makefile)$/;

function trackedUserFacing(): string[] {
    const r = spawnSync("git", ["ls-files", "-z"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    expect(r.status).toBe(0);
    return r.stdout
        .split("\0")
        .filter(Boolean)
        .filter(
            (f) =>
                SCANNED_EXT.test(f) && !NOT_GUIDANCE.some(([re]) => re.test(f)),
        );
}

function scanFiles(rels: string[]): string[] {
    const bad: string[] = [];
    for (const rel of rels) {
        const abs = join(REPO_ROOT, rel);
        if (!existsSync(abs)) continue;
        let raw = readFileSync(abs, "utf8");
        if (CODE_EXT.test(rel)) raw = stripCodeComments(raw);
        for (const h of commandHits(raw)) bad.push(`${rel}: ${h}`);
    }
    return bad;
}

describe("the matcher itself", () => {
    it("flags command forms", () => {
        for (const s of [
            "run `kn-next deploy` first",
            "npx kn-next create app",
            "npx --yes kn-next doctor",
            "bunx kn-next --help",
            "node_modules/.bin/kn-next",
            "command: ['kn-next', 'db', 'migrate']",
            "$ kn-next db migrate",
        ]) {
            expect(commandHits(s).length, s).toBe(1);
        }
    });
    it("flags the wrapped, commented, --package and array forms", () => {
        for (const s of [
            // wrapped: the verb is on the next line
            "run `npx --package @getknext/core kn-next\ndoctor` first",
            // shell continuation
            "npx --package @getknext/core kn-next \\\n  doctor",
            // wrapped inside a markdown paragraph / blockquote
            "> `npx --package @getknext/core kn-next\n> doctor`",
            // commented command in a template / doc
            "# run: kn-next build --self-contained",
            "// then kn-next deploy",
            " * Run `kn-next build` first",
            // npx -p / --package=
            "npx -p @getknext/core kn-next doctor",
            "npx --package=@getknext/core kn-next doctor",
            // JSON / YAML arrays
            'command: ["kn-next", "db", "migrate"]',
            'command: ["kn-next","db","migrate"]',
            "args: ['kn-next', 'db']",
            // backticked bare command word, and prose imperatives
            "This installs the `kn-next` command",
            "run kn-next from here",
        ]) {
            expect(commandHits(s).length, s).toBeGreaterThan(0);
        }
    });
    it("flags a command rename that leaked into a package name", () => {
        for (const x of [
            "npm view knext dist-tags",
            "npm install knext",
            "npm i knext --save",
            "npm dist-tag add knext@1.0.0 latest",
        ]) {
            expect(commandHits(x).length, x).toBeGreaterThan(0);
        }
        for (const ok of [
            "npm view kn-next dist-tags",
            "npm view @getknext/core version",
        ]) {
            expect(commandHits(ok), ok).toEqual([]);
        }
    });
    it("does not flag names, paths or prose", () => {
        for (const s of [
            "see kn-next.config.ts",
            "the kn-next-operator Deployment",
            "packages/kn-next/src/cli",
            "dist/cli/kn-next.js",
            "kn-next is a framework",
            "pino({ name: 'kn-next' })",
        ]) {
            expect(commandHits(s), s).toEqual([]);
        }
    });
});

describe("no user-facing string tells the user to run `kn-next`", () => {
    it("every tracked file that is not history, tooling or tests (scanned, not enumerated)", () => {
        const files = trackedUserFacing();
        // Non-vacuity: the scan must actually cover the surfaces that matter.
        for (const must of [
            "docs/QUICKSTART.md",
            "action.yml",
            "packages/kn-next/src/cli/help.ts",
            "packages/kn-next/templates/app/Dockerfile.self-contained.hbs",
        ]) {
            expect(files, `${must} must be in the scanned set`).toContain(must);
        }
        expect(scanFiles(files)).toEqual([]);
    });

    it("the running CLI: --help and every verb's --help", () => {
        const entry = join(PKG, "src", "cli", "deploy.ts");
        const run = (args: string[]) => {
            const r = spawnSync("bun", [entry, ...args], {
                encoding: "utf8",
                timeout: 60_000,
            });
            return `${r.stdout}\n${r.stderr}`;
        };
        const top = run(["--help"]);
        expect(top).toContain("knext");
        const verbs = [...top.matchAll(/^\s{2}([a-z][a-z-]+)\s{2,}/gm)].map(
            (m) => m[1],
        );
        expect(verbs.length).toBeGreaterThan(3);
        const bad = [top, ...verbs.map((v) => run([v, "--help"]))].flatMap(
            commandHits,
        );
        expect(bad).toEqual([]);
    });
});
