/**
 * `knext --help` and the CLI reference must list the same commands.
 *
 * The docs page says "`knext --help` lists exactly this set" about the command
 * block at its top. This ties that claim to the code: the commands in the
 * block, and the commands the help prints, are the same set (the two internal
 * rows aside), so a command added to one and not the other reds here.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchGrpcVerb } from "../cli/grpc-dispatch";
import { CLI_HELP, COMMAND_GROUPS } from "../cli/help";

const here = dirname(fileURLToPath(import.meta.url));
const cliMdx = join(
    resolve(here, "..", "..", "..", ".."),
    "apps",
    "docs",
    "content",
    "docs",
    "cli.mdx",
);

/** Commands in the help that the docs block deliberately leaves out. */
const HELP_ONLY = new Set(["ci-preflight", "vinext-patches"]);

/** The `knext ...` lines of the first bash block in the reference, as bare command names. */
function documentedCommands(): string[] {
    const text = readFileSync(cliMdx, "utf8");
    const block = /```bash\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
    return block
        .split("\n")
        .filter((l) => l.startsWith("knext "))
        .map((l) =>
            l
                .slice("knext ".length)
                .split(/\s+#/)[0]
                .replace(/^\[(\w+)\]$/, "$1")
                .trim(),
        );
}

/** The help's command names, "deploy (default)" reduced to "deploy". */
function helpCommands(): string[] {
    return COMMAND_GROUPS.flatMap((g) =>
        g.commands.map((c) => c.display.replace(/ \(default\)$/, "")),
    );
}

describe("knext --help matches the CLI reference", () => {
    it("lists exactly the documented commands (besides the internal rows)", () => {
        const docs = new Set(documentedCommands());
        const help = new Set(helpCommands().filter((c) => !HELP_ONLY.has(c)));
        expect([...docs].filter((c) => !help.has(c))).toEqual([]);
        expect([...help].filter((c) => !docs.has(c))).toEqual([]);
        expect(docs.size).toBeGreaterThan(12);
    });

    it("lists `deploy function` in the printed help", () => {
        expect(CLI_HELP).toContain("deploy function");
        expect(documentedCommands()).toContain("deploy function");
    });
});

describe("the install hint names every command the package provides", () => {
    it("`deploy function --help` without the package names deploy function, add function and generate", async () => {
        let out = "";
        const missing = async () => {
            throw Object.assign(new Error("Cannot find module"), {
                code: "MODULE_NOT_FOUND",
            });
        };
        const code = await dispatchGrpcVerb(
            "deploy",
            ["function", "--help"],
            "2.0.0",
            {
                load: missing,
                stdout: (s) => {
                    out += s;
                },
                stderr: () => {},
            },
        );
        expect(code).toBe(0);
        expect(out).toContain("`knext deploy function`");
        expect(out).toContain("`knext add function`");
        expect(out).toContain("`knext generate`");
    });
});
