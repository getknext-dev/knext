/**
 * exec.ts — node:child_process argv helpers for the kn-next CLI (CLI-58).
 *
 * These pin the shell:false contract at the seam: each helper spawns a discrete
 * argv (no /bin/sh), empty argv is a hard error, and the "allow fail" variant
 * tolerates a non-zero exit while the strict variants throw. isEntrypoint is the
 * symlink-correct self-entry guard every CLI module shares.
 *
 * Subprocesses are the current `node` (process.execPath) running `-e` snippets —
 * hermetic, no external binaries.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
    isEntrypoint,
    runCapture,
    runInherit,
    runQuiet,
    runQuietAllowFail,
} from "../cli/exec";

const NODE = process.execPath;

describe("runCapture", () => {
    it("captures and trims the child's stdout", () => {
        const out = runCapture([
            NODE,
            "-e",
            "process.stdout.write('  hello \\n')",
        ]);
        expect(out).toBe("hello");
    });

    it("throws on empty argv", () => {
        expect(() => runCapture([])).toThrow(/empty argv/);
    });

    it("throws when the child exits non-zero", () => {
        expect(() => runCapture([NODE, "-e", "process.exit(2)"])).toThrow();
    });
});

describe("runInherit", () => {
    it("runs a command with inherited stdio and returns nothing", () => {
        expect(runInherit([NODE, "-e", ""])).toBeUndefined();
    });

    it("throws on empty argv", () => {
        expect(() => runInherit([])).toThrow(/empty argv/);
    });

    it("throws when the child exits non-zero", () => {
        expect(() => runInherit([NODE, "-e", "process.exit(1)"])).toThrow();
    });
});

describe("runQuiet", () => {
    it("discards stdout and returns nothing on success", () => {
        expect(
            runQuiet([NODE, "-e", "process.stdout.write('noise')"]),
        ).toBeUndefined();
    });

    it("throws on empty argv", () => {
        expect(() => runQuiet([])).toThrow(/empty argv/);
    });

    it("throws when the child exits non-zero", () => {
        expect(() => runQuiet([NODE, "-e", "process.exit(4)"])).toThrow();
    });
});

describe("runQuietAllowFail", () => {
    it("TOLERATES a non-zero exit (does not throw)", () => {
        expect(() =>
            runQuietAllowFail([NODE, "-e", "process.exit(7)"]),
        ).not.toThrow();
    });

    it("also succeeds on a zero exit", () => {
        expect(() => runQuietAllowFail([NODE, "-e", ""])).not.toThrow();
    });

    it("throws on empty argv", () => {
        expect(() => runQuietAllowFail([])).toThrow(/empty argv/);
    });
});

describe("isEntrypoint", () => {
    it("returns true when import.meta.url resolves to the process entry", () => {
        // process.argv[1] under vitest is a real, existing file; its file URL is
        // exactly what a directly-run module's import.meta.url would be.
        const selfUrl = pathToFileURL(realpathSync(process.argv[1])).href;
        expect(isEntrypoint(selfUrl)).toBe(true);
    });

    it("returns false when the module URL is a different existing file", () => {
        expect(isEntrypoint(import.meta.url)).toBe(false);
    });

    it("returns false (never throws) when the URL cannot be realpath-resolved", () => {
        expect(isEntrypoint("file:///nonexistent/path/does/not/exist.js")).toBe(
            false,
        );
    });
});
