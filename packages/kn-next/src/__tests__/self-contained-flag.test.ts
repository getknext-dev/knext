/**
 * `--self-contained` / `selfContained` (opt-in). Honoured by the
 * standalone/node compile path (embeds `.next/server` into the executable,
 * proven by apps/file-manager/self-contained-e2e.test.ts); the vinext/bun-exec
 * target does not honour it yet — it is still recorded, never silently
 * dropped.
 *
 * Real modules only — the routing half (mocked compile steps) lives in
 * `self-contained-routing.test.ts`. This file pins: the config key's validator,
 * that the emitted NextApp CR does not change, that the flag is documented in
 * `--help`, and that the compile argv the vinext/bun-exec target builds is
 * byte-identical whether the option is absent, false or true (that target
 * only records it today; the standalone/node target's own argv shape is
 * covered where it plans self-contained embedding, not here).
 */

import { describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCEPTED_BUILD_FLAGS, BUILD_HELP } from "../cli/build";
import { buildNextAppCRObject } from "../cli/cr-builder";
import { validateConfig } from "../cli/validate";
import { buildVinextExecutable } from "../cli/vinext-build";
import type { KnativeNextConfig } from "../config";

function cfg(over: Record<string, unknown> = {}): KnativeNextConfig {
    return {
        name: "app",
        registry: "reg.io/team",
        ...over,
    } as KnativeNextConfig;
}

describe("selfContained config key", () => {
    it("is optional — absence validates (default off)", () => {
        expect(() => validateConfig(cfg())).not.toThrow();
    });

    it.each([true, false])("accepts %s", (v) => {
        expect(() => validateConfig(cfg({ selfContained: v }))).not.toThrow();
    });

    it.each([
        "true",
        "yes",
        1,
        0,
        null,
        {},
    ])("rejects a non-boolean (%p)", (v) => {
        expect(() => validateConfig(cfg({ selfContained: v }))).toThrow(
            /selfContained/,
        );
    });

    it("does not change the emitted NextApp CR (no CR field yet)", () => {
        const base = buildNextAppCRObject(
            cfg(),
            "reg.io/team/app@sha256:abc",
            "ns",
        );
        for (const v of [true, false]) {
            expect(
                buildNextAppCRObject(
                    cfg({ selfContained: v }),
                    "reg.io/team/app@sha256:abc",
                    "ns",
                ),
            ).toEqual(base);
        }
    });
});

describe("knext build --self-contained is a documented flag", () => {
    it("is in the accepted-flag set the reference-app guard reads", () => {
        expect(ACCEPTED_BUILD_FLAGS.has("--self-contained")).toBe(true);
    });
    it("is described in --help", () => {
        expect(BUILD_HELP).toMatch(/^ {2}--self-contained {2,}\S/m);
    });
});

describe("compile argv is byte-identical with the option absent, false or true", () => {
    function argvFor(selfContained: boolean | undefined): string[][] {
        const cwd = mkdtempSync(join(tmpdir(), "knext-f5-"));
        try {
            mkdirSync(join(cwd, ".output", "server"), { recursive: true });
            writeFileSync(join(cwd, ".output", "server", "index.mjs"), "");
            const calls: string[][] = [];
            buildVinextExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.4.0",
                skipViteBuild: true,
                run: (argv) => calls.push([...argv]),
                ...(selfContained === undefined ? {} : { selfContained }),
            });
            return calls;
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    }

    it("vinext", () => {
        const absent = argvFor(undefined);
        expect(absent.length).toBe(1);
        expect(argvFor(false)).toEqual(absent);
        expect(argvFor(true)).toEqual(absent);
    });
});

describe("the docs site documents the flag and the key", () => {
    const docs = (rel: string) =>
        readFileSync(
            join(
                import.meta.dir,
                "..",
                "..",
                "..",
                "..",
                "apps",
                "docs",
                "content",
                "docs",
                rel,
            ),
            "utf8",
        );
    it("cli reference lists --self-contained", () => {
        expect(docs("cli.mdx")).toContain("--self-contained");
    });
    it("build-pipeline documents selfContained", () => {
        expect(docs("build-pipeline.mdx")).toContain("selfContained: true,");
    });
});
