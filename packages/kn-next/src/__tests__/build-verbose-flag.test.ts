/**
 * `knext build --verbose`: the compile steps' informational notes are folded
 * into a one-line count by default and listed with the flag. The flag reaches
 * the compile children through `KNEXT_VERBOSE`, which they inherit.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { ACCEPTED_BUILD_FLAGS, BUILD_HELP, buildMain } from "../cli/build";
import { CLI_CONTRACT } from "../cli/contract";

const saved = process.env.KNEXT_VERBOSE;
afterEach(() => {
    if (saved === undefined) delete process.env.KNEXT_VERBOSE;
    else process.env.KNEXT_VERBOSE = saved;
});

describe("knext build --verbose", () => {
    it("is an accepted flag, in the CLI contract, and documented in --help", () => {
        expect(ACCEPTED_BUILD_FLAGS.has("--verbose")).toBe(true);
        const verb = CLI_CONTRACT.find((v) => v.verb === "build");
        expect(verb?.flags).toContain("--verbose");
        expect(BUILD_HELP).toContain("--verbose");
    });

    it("exports KNEXT_VERBOSE=1 for the compile children when passed", async () => {
        delete process.env.KNEXT_VERBOSE;
        // An unknown flag makes buildMain reject BEFORE any build starts, so
        // nothing is built here; only the env is under test.
        await expect(buildMain(["--verbose", "--bogus"])).rejects.toThrow(
            /unknown flag/,
        );
        expect(process.env.KNEXT_VERBOSE).toBe("1");
    });

    it("leaves KNEXT_VERBOSE alone when the flag is absent", async () => {
        delete process.env.KNEXT_VERBOSE;
        await expect(buildMain(["--bogus"])).rejects.toThrow(/unknown flag/);
        expect(process.env.KNEXT_VERBOSE).toBeUndefined();
    });
});
