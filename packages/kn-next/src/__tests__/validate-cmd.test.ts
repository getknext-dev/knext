/**
 * UX ledger row 4 (4a) — `kn-next validate` is a routed verb.
 *
 * validate runs config load + the schema checks + the placeholder preflight,
 * WITHOUT cluster access: plain output on both streams, exit 0/1. The verb
 * contract (help row, allowlist entry, argv parsing, `--help` never working)
 * is enforced by the existing scan suites the moment the verb exists —
 * cli-dispatch-contract, cli-help-surface, and the dist-bin tests all derive
 * their cases from COMMAND_GROUPS. This file pins the behavior of
 * validateMain itself, hermetically, on injected streams.
 */

import { describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../cli/shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../cli/shared")>()),
    loadConfig,
}));

import {
    CONFIG_NOT_FOUND_CODE,
    ConfigNotFoundError,
    USAGE_ERROR_CODE,
} from "../cli/shared";
import { ConfigValidationError } from "../cli/validate";
import { validateMain } from "../cli/validate-cmd";

/** Run validateMain against captured stdout/stderr. */
async function runValidate(argv: readonly string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await validateMain(argv, {
        out: (t) => stdout.push(t),
        err: (t) => stderr.push(t),
    });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

const clean = {
    name: "my-app",
    registry: "ghcr.io/real-user",
};

describe("validateMain — help and argv strictness", () => {
    it("--help prints usage to stdout, exits 0, loads nothing", async () => {
        const r = await runValidate(["--help"]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("kn-next validate");
        // the persona's question: does this touch my cluster?
        expect(r.stdout.toLowerCase()).toContain("no cluster");
        expect(r.stderr).toBe("");
        expect(loadConfig).not.toHaveBeenCalled();
    });

    it("rejects an unknown flag as a UsageError BEFORE loading config", async () => {
        await expect(validateMain(["--zzz"])).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("--zzz"),
        });
        expect(loadConfig).not.toHaveBeenCalled();
    });

    it("rejects a stray positional as a UsageError", async () => {
        await expect(validateMain(["my-app"])).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("my-app"),
        });
        expect(loadConfig).not.toHaveBeenCalled();
    });
});

describe("validateMain — verdicts", () => {
    it("valid config: exit 0, verdict on stdout, stderr silent", async () => {
        loadConfig.mockResolvedValueOnce(clean);
        const r = await runValidate([]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("kn-next.config.ts");
        expect(r.stdout.toLowerCase()).toContain("valid");
        expect(r.stderr).toBe("");
    });

    it("placeholder config: exit 1, per-field guidance on stderr, stdout silent", async () => {
        loadConfig.mockResolvedValueOnce({
            ...clean,
            registry: "ghcr.io/<your-user>",
        });
        const r = await runValidate([]);
        expect(r.code).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("registry");
        expect(r.stderr).toContain("ghcr.io/<your-user>");
        expect(r.stderr).toContain("https://knext.dev");
        expect(r.stderr).not.toContain("FATAL");
        expect(r.stderr).not.toMatch(/\n\s+at\s/);
    });

    it("schema-invalid config: exit 1, the validator's plain message, no throw", async () => {
        // loadConfig itself throws ConfigValidationError (shared.ts runs
        // validateConfig at load). validate must render it as its verdict,
        // never re-throw into a FATAL dump.
        loadConfig.mockRejectedValueOnce(
            new ConfigValidationError("\n  - 'name' is required"),
        );
        const r = await runValidate([]);
        expect(r.code).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("'name' is required");
        expect(r.stderr).not.toMatch(/\n\s+at\s/);
    });

    it("missing config propagates — the dispatcher owns that guidance", async () => {
        loadConfig.mockRejectedValueOnce(
            new ConfigNotFoundError("/tmp/x/kn-next.config.ts", "/tmp/x"),
        );
        await expect(validateMain([])).rejects.toMatchObject({
            code: CONFIG_NOT_FOUND_CODE,
        });
    });
});

describe("validate never reaches for a cluster", () => {
    it("validate-cmd.ts imports no exec/kubectl surface (static scan)", async () => {
        const { readFileSync } = await import("node:fs");
        const { dirname, join, resolve } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(
            join(resolve(here, ".."), "cli", "validate-cmd.ts"),
            "utf8",
        );
        // quote-style-proof: the formatter may flip string quote style
        expect(src).not.toMatch(/from\s+['"]\.\/exec['"]/);
        expect(src).not.toMatch(/from\s+['"]\.\/schema\//);
        expect(src).not.toContain("kubectl");
        expect(src).not.toContain("spawnSync");
        expect(src).not.toContain("execFileSync");
    });
});
