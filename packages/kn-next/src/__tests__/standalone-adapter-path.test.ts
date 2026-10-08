/**
 * The Next.js < 16.4.0 `adapterPath` workaround, unit level: the version gate,
 * exactly what gets rewritten, and that nothing else does.
 *
 * The behavioural proof against a real `next build` + served standalone server
 * is `standalone-adapter-path-404.test.ts`; the call site is
 * `compile-artifact-adapter-path.test.ts`.
 */

import { afterAll, describe, expect, it } from "bun:test";
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
    ADAPTER_PATH_404_FIXED_IN,
    blankStandaloneAdapterPath,
    nextCarriesAdapter404Bug,
    resolveStandaloneNextVersion,
} from "../adapters/standalone-adapter-path";

const tempRoots: string[] = [];
afterAll(() => {
    for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
});

const ADAPTER = "/build/agent/adapter.mjs";

/** What `next build` inlines into `server.js` (the shape that matters). */
function serverJs(adapterPath: string | null = ADAPTER): string {
    const config = {
        distDir: "./.next",
        output: "standalone",
        ...(adapterPath === null ? {} : { adapterPath }),
        experimental: { ppr: false },
        env: {},
    };
    return `const nextConfig = ${JSON.stringify(config)}\n\nprocess.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)\n\nrequire('next')\n`;
}

/** `required-server-files.json` is pretty-printed, so the member has a space. */
function requiredServerFiles(adapterPath: string | null = ADAPTER): string {
    return `${JSON.stringify(
        {
            version: 1,
            config: {
                output: "standalone",
                ...(adapterPath === null ? {} : { adapterPath }),
            },
            appDir: "/x",
        },
        null,
        2,
    )}\n`;
}

/** A standalone tree with a `next` of the given version in its node_modules. */
function tree(opts: {
    nextVersion?: string;
    adapterPath?: string | null;
    nested?: boolean;
}): { root: string; serverDir: string } {
    const root = mkdtempSync(join(tmpdir(), "knext-adapterpath-unit-"));
    tempRoots.push(root);
    const serverDir = opts.nested ? join(root, "apps", "web") : root;
    mkdirSync(join(serverDir, ".next"), { recursive: true });
    writeFileSync(join(serverDir, "server.js"), serverJs(opts.adapterPath));
    writeFileSync(
        join(serverDir, ".next", "required-server-files.json"),
        requiredServerFiles(opts.adapterPath),
    );
    if (opts.nextVersion) {
        // Hoisted to the tree root, as a monorepo's traced deps are.
        const nextDir = join(root, "node_modules", "next");
        mkdirSync(nextDir, { recursive: true });
        writeFileSync(
            join(nextDir, "package.json"),
            JSON.stringify({ name: "next", version: opts.nextVersion }),
        );
    }
    return { root, serverDir };
}

const read = (p: string) => readFileSync(p, "utf8");

describe("nextCarriesAdapter404Bug -- the version gate", () => {
    it("fixed-in is 16.4.0", () => {
        expect(ADAPTER_PATH_404_FIXED_IN).toBe("16.4.0");
    });

    it.each([
        "16.0.0",
        "16.2.12",
        "16.3.0",
        "16.3.5",
        "16.3.6",
        "16.3.8",
        "16.3.99",
        "15.9.9",
    ])("%s is affected", (v) => {
        expect(nextCarriesAdapter404Bug(v)).toBe(true);
    });

    it.each([
        "16.4.0",
        "16.4.1",
        "16.10.0",
        "17.0.0",
        "16.4.0+build.5",
    ])("%s is fixed", (v) => {
        expect(nextCarriesAdapter404Bug(v)).toBe(false);
    });

    it("compares numerically, not lexically (16.10 is above 16.4)", () => {
        expect(nextCarriesAdapter404Bug("16.10.0")).toBe(false);
        expect(nextCarriesAdapter404Bug("16.9.0")).toBe(false);
        expect(nextCarriesAdapter404Bug("16.3.10")).toBe(true);
    });

    it("a pre-release of 16.4.0 sorts below it (semver) and is still blanked", () => {
        expect(nextCarriesAdapter404Bug("16.4.0-canary.12")).toBe(true);
        expect(nextCarriesAdapter404Bug("16.4.1-canary.1")).toBe(false);
        expect(nextCarriesAdapter404Bug("16.3.9-rc.1")).toBe(true);
    });

    it.each([
        "",
        "latest",
        "16",
        "16.4",
        "garbage",
    ])("%p is unparseable, so neither affected nor fixed", (v) => {
        expect(nextCarriesAdapter404Bug(v)).toBeNull();
    });
});

describe("blankStandaloneAdapterPath -- what it rewrites", () => {
    it("blanks adapterPath in server.js AND required-server-files.json on an affected Next", () => {
        const { serverDir } = tree({ nextVersion: "16.3.6" });
        const result = blankStandaloneAdapterPath({ serverDir });

        expect(result.applied).toBe(true);
        expect(result.nextVersion).toBe("16.3.6");
        expect(result.files.sort()).toEqual(
            [
                join(serverDir, "server.js"),
                join(serverDir, ".next", "required-server-files.json"),
            ].sort(),
        );

        const server = read(join(serverDir, "server.js"));
        expect(server).not.toContain(ADAPTER);
        expect(server).toContain('"adapterPath":""');
        // The inlined config is still valid JSON with the rest intact.
        const inlined = JSON.parse(
            /const nextConfig = (.*)\n/.exec(server)?.[1] ?? "null",
        );
        expect(inlined).toEqual({
            distDir: "./.next",
            output: "standalone",
            adapterPath: "",
            experimental: { ppr: false },
            env: {},
        });

        const manifest = JSON.parse(
            read(join(serverDir, ".next", "required-server-files.json")),
        );
        expect(manifest.config.adapterPath).toBe("");
        expect(manifest.config.output).toBe("standalone");
        expect(manifest.appDir).toBe("/x");
    });

    it("changes nothing but the adapterPath value", () => {
        const { serverDir } = tree({ nextVersion: "16.3.6" });
        const before = read(join(serverDir, "server.js"));
        blankStandaloneAdapterPath({ serverDir });
        const after = read(join(serverDir, "server.js"));
        expect(after).toBe(
            before.replace(`"adapterPath":"${ADAPTER}"`, `"adapterPath":""`),
        );
    });

    it("handles a value with JSON escapes (a Windows path)", () => {
        const { serverDir } = tree({
            nextVersion: "16.3.6",
            adapterPath: 'C:\\build\\a "q" b\\adapter.mjs',
        });
        blankStandaloneAdapterPath({ serverDir });
        expect(read(join(serverDir, "server.js"))).toContain(
            '"adapterPath":""',
        );
        expect(read(join(serverDir, "server.js"))).not.toContain("adapter.mjs");
        expect(
            JSON.parse(
                read(join(serverDir, ".next", "required-server-files.json")),
            ).config.adapterPath,
        ).toBe("");
    });

    it("is idempotent: a second run rewrites nothing", () => {
        const { serverDir } = tree({ nextVersion: "16.3.6" });
        blankStandaloneAdapterPath({ serverDir });
        const once = read(join(serverDir, "server.js"));
        const second = blankStandaloneAdapterPath({ serverDir });
        expect(second.applied).toBe(false);
        expect(second.files).toEqual([]);
        expect(read(join(serverDir, "server.js"))).toBe(once);
    });

    it("works on a nested (monorepo) layout where next is hoisted above the server", () => {
        const { serverDir } = tree({ nextVersion: "16.3.6", nested: true });
        const result = blankStandaloneAdapterPath({ serverDir });
        expect(result.applied).toBe(true);
        expect(read(join(serverDir, "server.js"))).toContain(
            '"adapterPath":""',
        );
    });

    it("reports 'nothing to blank' when the build set no adapterPath", () => {
        const { serverDir } = tree({
            nextVersion: "16.3.6",
            adapterPath: null,
        });
        const before = read(join(serverDir, "server.js"));
        const result = blankStandaloneAdapterPath({ serverDir });
        expect(result.applied).toBe(false);
        expect(result.reason).toContain("sets no adapterPath");
        expect(read(join(serverDir, "server.js"))).toBe(before);
    });

    it("tolerates a missing required-server-files.json and a missing server.js", () => {
        const { serverDir } = tree({ nextVersion: "16.3.6" });
        rmSync(join(serverDir, ".next", "required-server-files.json"));
        const only = blankStandaloneAdapterPath({ serverDir });
        expect(only.files).toEqual([join(serverDir, "server.js")]);

        const empty = mkdtempSync(join(tmpdir(), "knext-adapterpath-unit-"));
        tempRoots.push(empty);
        expect(() =>
            blankStandaloneAdapterPath({
                serverDir: empty,
                nextVersion: "16.3.6",
            }),
        ).not.toThrow();
    });
});

describe("blankStandaloneAdapterPath -- strictly gated on the Next.js version", () => {
    it.each([
        "16.4.0",
        "16.4.1",
        "17.0.0",
    ])("Next %s: leaves every byte alone", (nextVersion) => {
        const { serverDir } = tree({ nextVersion });
        const server = read(join(serverDir, "server.js"));
        const manifest = read(
            join(serverDir, ".next", "required-server-files.json"),
        );
        const result = blankStandaloneAdapterPath({ serverDir });
        expect(result.applied).toBe(false);
        expect(result.nextVersion).toBe(nextVersion);
        expect(result.reason).toContain("no workaround needed");
        expect(read(join(serverDir, "server.js"))).toBe(server);
        expect(
            read(join(serverDir, ".next", "required-server-files.json")),
        ).toBe(manifest);
    });

    it("an explicit nextVersion overrides what is installed", () => {
        const { serverDir } = tree({ nextVersion: "16.3.6" });
        const result = blankStandaloneAdapterPath({
            serverDir,
            nextVersion: "16.4.0",
        });
        expect(result.applied).toBe(false);
        expect(read(join(serverDir, "server.js"))).toContain(ADAPTER);
    });

    it("an unreadable Next version is NOT treated as affected: nothing is rewritten, and it says so", () => {
        const { serverDir } = tree({}); // no node_modules/next anywhere
        const logs: string[] = [];
        const result = blankStandaloneAdapterPath({
            serverDir,
            log: (m) => logs.push(m),
        });
        expect(result.applied).toBe(false);
        expect(result.nextVersion).toBeNull();
        expect(result.reason).toContain(
            "could not read the installed Next.js version",
        );
        expect(logs.join("\n")).toContain(
            "could not read the installed Next.js version",
        );
        expect(read(join(serverDir, "server.js"))).toContain(ADAPTER);
    });

    it("an unrecognisable version string is NOT treated as affected", () => {
        const { serverDir } = tree({});
        const result = blankStandaloneAdapterPath({
            serverDir,
            nextVersion: "canary",
        });
        expect(result.applied).toBe(false);
        expect(result.reason).toContain("not a recognisable version");
        expect(read(join(serverDir, "server.js"))).toContain(ADAPTER);
    });
});

describe("resolveStandaloneNextVersion", () => {
    it("reads the next the server would require, walking up from the server dir", () => {
        const { serverDir } = tree({ nextVersion: "16.3.5", nested: true });
        expect(resolveStandaloneNextVersion(serverDir)).toBe("16.3.5");
    });

    it("falls back to the project dir when the tree carries no next", () => {
        const bare = tree({});
        const project = tree({ nextVersion: "16.3.8" });
        expect(
            resolveStandaloneNextVersion(bare.serverDir, project.serverDir),
        ).toBe("16.3.8");
    });

    it("is null when neither has one", () => {
        const { serverDir } = tree({});
        expect(existsSync(join(serverDir, "node_modules"))).toBe(false);
        expect(resolveStandaloneNextVersion(serverDir)).toBeNull();
    });
});
