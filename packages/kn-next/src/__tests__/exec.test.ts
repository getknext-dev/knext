/**
 * exec.ts — node:child_process argv helpers for the knext CLI (CLI-58).
 *
 * These pin the shell:false contract at the seam: each helper spawns a discrete
 * argv (no /bin/sh), empty argv is a hard error, and the "allow fail" variant
 * tolerates a non-zero exit while the strict variants throw. isEntrypoint is the
 * symlink-correct self-entry guard every CLI module shares.
 *
 * Subprocesses are the current `node` (process.execPath) running `-e` snippets —
 * hermetic, no external binaries.
 */

import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

    // #1385 — the vinext compile step's stdout (console.log lines the docs
    // quote, e.g. which server externals load from
    // .output/server/node_modules vs. stay bundled) was silently discarded,
    // exactly like the noise above. Its console.warn lines were already
    // visible (stderr, already inherited) — only the console.log half was
    // ever at risk. `surfaceStdoutPrefix` opts a call site INTO surfacing
    // only the lines it cares about — everything else stays quiet.
    describe("surfaceStdoutPrefix", () => {
        it("prints only the lines starting with the given prefix, via console.log, after the run completes", () => {
            const originalLog = console.log;
            const printed: unknown[][] = [];
            console.log = (...args: unknown[]) => {
                printed.push(args);
            };
            try {
                runQuiet(
                    [
                        NODE,
                        "-e",
                        "process.stdout.write('noise line\\n[marker] a warning\\nmore noise\\n[marker] a second warning\\n')",
                    ],
                    { surfaceStdoutPrefix: "[marker]" },
                );
            } finally {
                console.log = originalLog;
            }
            expect(printed).toEqual([
                ["[marker] a warning"],
                ["[marker] a second warning"],
            ]);
        });

        it("prints nothing extra when no line matches the prefix (stays quiet)", () => {
            const originalLog = console.log;
            const printed: unknown[][] = [];
            console.log = (...args: unknown[]) => {
                printed.push(args);
            };
            try {
                runQuiet(
                    [NODE, "-e", "process.stdout.write('just noise\\n')"],
                    { surfaceStdoutPrefix: "[marker]" },
                );
            } finally {
                console.log = originalLog;
            }
            expect(printed).toEqual([]);
        });

        it("without the option, behaves exactly as before (fully quiet, no console.log)", () => {
            const originalLog = console.log;
            const printed: unknown[][] = [];
            console.log = (...args: unknown[]) => {
                printed.push(args);
            };
            try {
                runQuiet([
                    NODE,
                    "-e",
                    "process.stdout.write('[marker] would surface if asked\\n')",
                ]);
            } finally {
                console.log = originalLog;
            }
            expect(printed).toEqual([]);
        });

        it("still surfaces matching lines even when the child exits non-zero, then rethrows", () => {
            const originalLog = console.log;
            const printed: unknown[][] = [];
            console.log = (...args: unknown[]) => {
                printed.push(args);
            };
            try {
                expect(() =>
                    runQuiet(
                        [
                            NODE,
                            "-e",
                            "process.stdout.write('[marker] warned before failing\\n'); process.exit(3)",
                        ],
                        { surfaceStdoutPrefix: "[marker]" },
                    ),
                ).toThrow();
            } finally {
                console.log = originalLog;
            }
            expect(printed).toEqual([["[marker] warned before failing"]]);
        });

        it("throws on empty argv even with the option set", () => {
            expect(() =>
                runQuiet([], { surfaceStdoutPrefix: "[marker]" }),
            ).toThrow(/empty argv/);
        });
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
        // A NAMED other file, not `import.meta.url`.
        //
        // Under vitest `process.argv[1]` is the runner, so this file was never
        // the entry and the old assertion held by accident. Under `bun test`
        // argv[1] IS the test file — so `isEntrypoint(import.meta.url)` is
        // correctly TRUE and the test failed while the code was right. It was
        // asserting a property of the runner, not of `isEntrypoint`.
        const other = pathToFileURL(
            realpathSync(
                resolve(
                    dirname(fileURLToPath(import.meta.url)),
                    "../cli/exec.ts",
                ),
            ),
        ).href;
        expect(other).not.toBe(
            pathToFileURL(realpathSync(process.argv[1])).href,
        );
        expect(isEntrypoint(other)).toBe(false);
    });

    it("returns false (never throws) when the URL cannot be realpath-resolved", () => {
        expect(isEntrypoint("file:///nonexistent/path/does/not/exist.js")).toBe(
            false,
        );
    });
});
