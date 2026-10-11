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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
export const COMMAND_FORM = new RegExp(
    [
        String.raw`\b(?:npx|bunx|pnpx|dlx|exec)(?:\s+(?:--?[\w-]+(?:=\S+)?))*\s+${BARE}`,
        String.raw`\.bin/kn-next\b`,
        // argv-array form: command: ['kn-next', 'db', 'migrate']
        String.raw`\[\s*['"]kn-next['"]\s*,`,
        // `kn-next <verb>` / `kn-next --flag`, but not prose such as
        // "kn-next is ..." -- see PROSE_VERB_STOPWORDS below.
        String.raw`${BARE}\s+(?:--?[a-z]|[a-z][\w-]*)`,
    ].join("|"),
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

function commandHits(text: string): string[] {
    const hits: string[] = [];
    for (const [i, line] of text.split("\n").entries()) {
        const m = COMMAND_FORM.exec(line);
        if (!m) continue;
        // Prose filter only applies to the bare `kn-next <word>` branch.
        const bare = /^kn-next\s+([a-z][\w-]*)/.exec(m[0]);
        if (bare && PROSE_STOPWORDS.has(bare[1])) continue;
        hits.push(`${i + 1}: ${line.trim().slice(0, 140)}`);
    }
    return hits;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name === ".next")
            continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

/** Source lines that are not comments: strings the user can actually see. */
function stripComments(text: string): string {
    return text
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l))
        .join("\n");
}

const TEXT_EXT =
    /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|mdx|sh|tmpl|txt|html)$|(^|\/)(Dockerfile|\.gitignore|\.env\.example)$/;

function scan(files: string[], strip: boolean): string[] {
    const bad: string[] = [];
    for (const f of files) {
        if (!TEXT_EXT.test(f)) continue;
        const raw = readFileSync(f, "utf8");
        for (const h of commandHits(strip ? stripComments(raw) : raw)) {
            bad.push(`${relative(REPO_ROOT, f)}:${h}`);
        }
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
    it("CLI + generator source (comments excluded)", () => {
        const files = walk(join(PKG, "src")).filter(
            (f) => !f.includes("__tests__") && !/\.test\./.test(f),
        );
        expect(scan(files, true)).toEqual([]);
    });

    it("scaffold templates", () => {
        expect(scan(walk(join(PKG, "templates")), false)).toEqual([]);
    });

    it("the GitHub Action", () => {
        expect(scan([join(REPO_ROOT, "action.yml")], true)).toEqual([]);
    });

    it("the published package README and the docs site content", () => {
        const files = [
            join(PKG, "README.md"),
            join(REPO_ROOT, "README.md"),
            ...walk(join(REPO_ROOT, "apps", "docs", "content")),
            ...walk(join(REPO_ROOT, "docs", "guides")),
            join(REPO_ROOT, "docs", "QUICKSTART.md"),
        ];
        expect(scan(files, false)).toEqual([]);
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
