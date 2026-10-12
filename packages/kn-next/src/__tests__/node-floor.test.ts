/**
 * node-floor.test.ts — the Node.js 24 floor, enforced at CLI start (v2 K5).
 *
 * `engines.node` only makes a package manager WARN; it does nothing for
 * `npx knext` on an old Node. So the CLI checks `process.versions.node`
 * itself, before it loads anything else, and exits non-zero naming the floor.
 *
 * Layers:
 *  1. The pure check (`checkNodeFloor`) with injected versions, incl. fail-closed
 *     on unparseable input.
 *  2. The CJS guard that ships in dist (dependency-free, so it can run on a Node
 *     too old for the rest of the bundle) agrees with the TS twin the doctor row
 *     uses — one message, two files, asserted equal.
 *  3. The BUILT bin: the guard is its first import, so nothing else evaluates
 *     first; and a stubbed Node 22 `process.versions` makes the real bin exit 1
 *     with the one-line message and no other output. No test-only seam exists in
 *     production code: the stub is a `--import` preload that redefines
 *     `process.versions.node`.
 *  4. A REAL Node 22 binary (KNEXT_NODE22_BIN) running the built bin — set by
 *     the `node-floor-real-22` CI job, where KNEXT_REQUIRE_NODE22=1 makes an
 *     absent binary a FAILURE. Locally, without a Node 22 installed, layer 3
 *     covers the same code path.
 *  5. Bun: its reported Node-compat version clears the floor, so the same bin
 *     runs under it without a false failure.
 *
 * dist/ must exist (CI builds @getknext/core before the suite).
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_BIN } from "../../../../tests/helpers/runtime-binaries";
import { checkNodeFloor, NODE_FLOOR_MAJOR } from "../cli/node-floor";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..");
const distBin = join(pkgRoot, "dist", "cli", "kn-next.js");
const distGuard = join(pkgRoot, "dist", "cli", "node-floor-guard.cjs");
const srcGuard = join(pkgRoot, "src", "cli", "node-floor-guard.cjs");

const MESSAGE_FOR_22 =
    "knext requires Node.js 24 or later; you are running 22.12.0. Upgrade Node: https://nodejs.org";

describe("checkNodeFloor (pure)", () => {
    it("the floor is Node 24", () => {
        expect(NODE_FLOOR_MAJOR).toBe(24);
    });

    it("names the floor, the running version and where to upgrade", () => {
        const r = checkNodeFloor("22.12.0");
        expect(r.ok).toBe(false);
        expect(r.message).toBe(MESSAGE_FOR_22);
    });

    it("is a single line", () => {
        expect(checkNodeFloor("20.0.0").message).not.toMatch(/\n/);
    });

    for (const v of ["24.0.0", "24.14.0", "25.1.0", "26.3.0"]) {
        it(`accepts ${v}`, () => {
            expect(checkNodeFloor(v).ok).toBe(true);
        });
    }

    for (const v of ["23.9.0", "22.18.0", "20.11.1", "18.20.8"]) {
        it(`rejects ${v}`, () => {
            expect(checkNodeFloor(v).ok).toBe(false);
        });
    }

    for (const v of ["", "abc", "v", ".24.0", undefined as unknown as string]) {
        it(`fails closed on unparseable input ${JSON.stringify(v)}`, () => {
            expect(checkNodeFloor(v).ok).toBe(false);
        });
    }
});

describe("the dist CJS guard agrees with the TS twin", () => {
    const req = createRequire(import.meta.url);
    const guard = req(srcGuard) as {
        NODE_FLOOR_MAJOR: number;
        checkNodeFloor: (v: string) => { ok: boolean; message: string };
    };
    it("same floor", () => {
        expect(guard.NODE_FLOOR_MAJOR).toBe(NODE_FLOOR_MAJOR);
    });
    for (const v of [
        "18.0.0",
        "22.12.0",
        "23.9.0",
        "24.0.0",
        "26.3.0",
        "",
        "garbage",
    ]) {
        it(`same verdict and message for ${JSON.stringify(v)}`, () => {
            expect(guard.checkNodeFloor(v)).toEqual(checkNodeFloor(v));
        });
    }
});

describe("the built bin", () => {
    it("dist exists (build @getknext/core first)", () => {
        expect(existsSync(distBin)).toBe(true);
        expect(existsSync(distGuard)).toBe(true);
    });

    it("the guard is the bin's FIRST import — nothing else evaluates before it", () => {
        const src = readFileSync(distBin, "utf8");
        const imports = [
            ...src.matchAll(/^import\s[^;\n]*?["']([^"']+)["'];?$/gm),
        ].map((m) => m[1]);
        expect(imports.length).toBeGreaterThan(1);
        expect(imports[0]).toBe("./node-floor-guard.cjs");
    });

    it("the guard is the first import of the source entry too", () => {
        const src = readFileSync(
            join(pkgRoot, "src", "cli", "deploy.ts"),
            "utf8",
        );
        const first = src.match(/^import\s[^;\n]*?["']([^"']+)["'];?$/m);
        expect(first?.[1]).toBe("./node-floor-guard.cjs");
    });

    // A preload that makes the running Node REPORT 22.12.0, so the real built
    // bin takes its real code path with no production-side seam.
    function runAs22(args: string[], entry: string = distBin) {
        const dir = mkdtempSync(join(tmpdir(), "knext-node-floor-"));
        try {
            const stub = join(dir, "stub.mjs");
            writeFileSync(
                stub,
                "Object.defineProperty(process.versions, 'node', { value: '22.12.0' });\n",
            );
            return spawnSync(NODE_BIN, ["--import", stub, entry, ...args], {
                encoding: "utf8",
                env: { ...process.env, NODE_OPTIONS: "", NO_COLOR: "1" },
                timeout: 30_000,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    for (const args of [["--help"], ["doctor"], ["deploy", "--help"], []]) {
        it(`reporting Node 22: \`knext ${args.join(" ")}\` exits 1 with only the floor line`, () => {
            const r = runAs22(args);
            expect(r.status).toBe(1);
            expect(r.stderr.trim()).toBe(MESSAGE_FOR_22);
            expect(r.stdout).toBe("");
        });
    }

    // Every runnable entry, found by SCANNING dist/cli for the node shebang
    // (the same rule the tsup hook uses), not by an enumerated list. cli.mdx
    // documents several of these as directly runnable.
    const cliDist = join(pkgRoot, "dist", "cli");
    const runnable = existsSync(cliDist)
        ? readdirSync(cliDist).filter(
              (f) =>
                  f.endsWith(".js") &&
                  readFileSync(join(cliDist, f), "utf8").startsWith(
                      "#!/usr/bin/env node\n",
                  ),
          )
        : [];

    it("finds the documented directly-runnable entries by scanning", () => {
        for (const f of [
            "kn-next.js",
            "preview.js",
            "loadtest.js",
            "build.js",
            "cleanup.js",
            "doctor.js",
        ]) {
            expect(runnable).toContain(f);
        }
    });

    for (const f of runnable) {
        it(`${f}: the guard is the first import`, () => {
            const src = readFileSync(join(cliDist, f), "utf8");
            const first = src.match(/^import\s[^;\n]*?["']([^"']+)["'];?$/m);
            expect(first?.[1]).toBe("./node-floor-guard.cjs");
        });
        it(`${f}: reporting Node 22 exits 1 with only the floor line`, () => {
            const r = runAs22(["--help"], join(cliDist, f));
            expect(r.status).toBe(1);
            expect(r.stderr.trim()).toBe(MESSAGE_FOR_22);
            expect(r.stdout).toBe("");
        });
    }

    it("on this (>=24) Node, --help still exits 0", () => {
        const r = spawnSync(NODE_BIN, [distBin, "--help"], {
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: "" },
            timeout: 30_000,
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/Usage|knext/i);
    });

    it("under Bun (reports a Node-compat version >= 24) --help exits 0", () => {
        const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
        expect(
            probe.status,
            "bun must be on PATH — this suite runs under bun",
        ).toBe(0);
        const r = spawnSync("bun", [distBin, "--help"], {
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: "" },
            timeout: 30_000,
        });
        expect(r.status).toBe(0);
        expect(r.stderr).not.toMatch(/requires Node\.js/);
    });
});

describe("a REAL Node 22 binary", () => {
    const bin = process.env.KNEXT_NODE22_BIN;
    const required = process.env.KNEXT_REQUIRE_NODE22 === "1";

    it("is available when required (CI job node-floor-real-22 sets KNEXT_REQUIRE_NODE22=1)", () => {
        if (required) {
            expect(
                bin,
                "KNEXT_NODE22_BIN must be set in the node-floor-real-22 job",
            ).toBeTruthy();
        }
    });

    it("`node@22 dist/cli/build.js` (a non-bin entry) exits non-zero naming the floor", () => {
        if (!bin) {
            return;
        }
        const r = spawnSync(
            bin,
            [join(pkgRoot, "dist", "cli", "build.js"), "--help"],
            {
                encoding: "utf8",
                env: { ...process.env, NODE_OPTIONS: "" },
                timeout: 30_000,
            },
        );
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("knext requires Node.js 24 or later");
    });

    it("`node@22 knext --help` exits non-zero naming the floor", () => {
        if (!bin) {
            return;
        }
        const v = spawnSync(bin, ["-p", "process.versions.node"], {
            encoding: "utf8",
        });
        expect(v.stdout.trim().split(".")[0]).toBe("22");
        const r = spawnSync(bin, [distBin, "--help"], {
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: "" },
            timeout: 30_000,
        });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("knext requires Node.js 24 or later");
        expect(r.stderr).toContain(`you are running ${v.stdout.trim()}`);
        expect(r.stdout).toBe("");
    });
});
