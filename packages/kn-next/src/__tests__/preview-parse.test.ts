/**
 * preview.ts — parsePreviewArgs (the `kn-next preview <deploy|destroy>` argv
 * parser). Pins the subcommand contract, flag mapping, namespace default, and
 * the loud rejection of an unknown/missing subcommand.
 */

import { describe, expect, it } from "bun:test";
import { parsePreviewArgs } from "../cli/preview";

describe("parsePreviewArgs", () => {
    it("parses `deploy` with --pr, --branch and -n", () => {
        const a = parsePreviewArgs([
            "deploy",
            "--pr",
            "42",
            "--branch",
            "feat/x",
            "-n",
            "previews",
        ]);
        expect(a.command).toBe("deploy");
        expect(a.prId).toBe("42");
        expect(a.branch).toBe("feat/x");
        expect(a.namespace).toBe("previews");
    });

    it("parses `destroy` and defaults the namespace", () => {
        const a = parsePreviewArgs(["destroy", "--pr", "7"]);
        expect(a.command).toBe("destroy");
        expect(a.prId).toBe("7");
        expect(a.namespace).toBe("default");
        expect(a.branch).toBeUndefined();
    });

    it("throws on an unknown subcommand", () => {
        expect(() => parsePreviewArgs(["frobnicate", "--pr", "1"])).toThrow(
            /expected subcommand "deploy" or "destroy"/,
        );
    });

    it("throws when no subcommand is given", () => {
        expect(() => parsePreviewArgs([])).toThrow(/expected subcommand/);
    });
});
