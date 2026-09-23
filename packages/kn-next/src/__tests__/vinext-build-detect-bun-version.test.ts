/**
 * `detectBunVersion`'s two FAILURE branches (#1235, coverage batch B4).
 *
 * The happy path (a real `bun --version` on PATH) is exercised throughout
 * `vinext-build.test.ts` / `vinext-build-coverage.test.ts`. Neither of
 * `detectBunVersion`'s catch branches was: `execFileSync("bun", …)` is a
 * STATIC top-level import (the file's own docblock explains why — a lazy
 * `require` breaks under Node's esbuild shim), so there is no injectable run
 * seam for it, unlike `run` elsewhere in this file (which `detectBunVersion`
 * itself receives but never calls — the parameter exists only so the
 * injection point stays visible, per its own comment). `node:child_process`
 * is mocked here instead, the same seam `loadtest-run.test.ts` /
 * `loadtest-cli-run.test.ts` already use for the same reason: no real `bun`
 * (or lack of one) needs to be on this machine for the test to be
 * deterministic.
 */

import { describe, expect, it, mock } from "bun:test";

const execFileSync = (() =>
    mock<(cmd: string, args: readonly string[], opts?: unknown) => string>(
        () => "1.4.2",
    ))();
const __knextRealChildProcess = { ...(await import("node:child_process")) };
mock.module("node:child_process", async () => {
    const actual = __knextRealChildProcess;
    const overridden = { ...actual, execFileSync };
    return {
        ...overridden,
        default: {
            ...(actual as { default?: object }).default,
            execFileSync,
        },
    };
});

const { detectBunVersion } = await import("../cli/vinext-build");

describe("#1235 detectBunVersion — bun missing from PATH (ENOENT)", () => {
    it("names the install page, not a generic spawn failure", () => {
        execFileSync.mockImplementationOnce(() => {
            const err = new Error(
                "spawnSync bun ENOENT",
            ) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
        });

        let thrown: unknown;
        try {
            detectBunVersion(() => {});
        } catch (e) {
            thrown = e;
        }
        // Tight to the ENOENT-specific sentence, not merely "the message
        // mentions bun.sh somewhere" — this message itself links bun.sh
        // TWICE (the install page here, plus the docs-install URL two
        // sentences later), so a loose `/bun\.sh/` match is satisfied by
        // either one and would not actually pin down which sentence fired.
        expect(String(thrown)).toMatch(
            /needs `bun` on PATH \(https:\/\/bun\.sh\), and it was not found/,
        );
        expect(String(thrown)).not.toMatch(/did not return a version/);
    });
});

describe("#1235 detectBunVersion — bun present but the spawn itself fails", () => {
    /** A single throw, installed fresh for each assertion in this `it`. */
    function throwOnce(): void {
        const err = new Error("Command failed") as NodeJS.ErrnoException & {
            stderr?: string;
        };
        err.code = "EACCES";
        err.stderr = "permission denied";
        execFileSync.mockImplementationOnce(() => {
            throw err;
        });
    }

    it("does NOT mislabel a crashing/non-zero bun as a missing install (#948), and surfaces its stderr", () => {
        throwOnce();
        let thrown: unknown;
        try {
            detectBunVersion(() => {});
        } catch (e) {
            thrown = e;
        }
        expect(String(thrown)).toMatch(/did not return a version/);
        expect(String(thrown)).toMatch(/permission denied/);
        // Never claims bun is missing — the opposite mislabel #948 fixed.
        expect(String(thrown)).not.toMatch(/was not found/);
    });

    it("still reports the underlying error when the thrown value carries no stderr", () => {
        execFileSync.mockImplementationOnce(() => {
            throw "a non-Error thrown value";
        });

        expect(() => detectBunVersion(() => {})).toThrow(
            /Underlying error: a non-Error thrown value/,
        );
    });
});
