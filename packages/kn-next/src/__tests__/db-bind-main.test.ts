/**
 * db-bind.ts — the `dbMain` subcommand dispatcher and the printDsnContract DSN
 * side-channel (ADR-0019). Complements db-bind.test.ts (pure validators + the
 * live-CR write path) with:
 *  - printDsnContract resolving a DSN from a --secret-file manifest, plus its
 *    unreadable-file and key-not-found "note" branches,
 *  - dbMain routing: unknown subcommand throws, `migrate` delegates, `bind`
 *    resolves an app name (positional or config) and runs the dry-run patch.
 *
 * dbMain reads existsSync("kn-next.config.ts") from cwd, so these run in a temp
 * cwd with no config file (app name must come from the positional).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runDbMigrate = (() => mock(async () => {}))();
mock.module("../cli/db-migrate", () => ({ runDbMigrate }));

import { dbMain, runDbBind } from "../cli/db-bind";

let dir: string;
const savedCwd = process.cwd();

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-dbmain-"));
    process.chdir(dir);
    runDbMigrate.mockClear();
});

afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

describe("printDsnContract (via runDbBind --dry-run --secret-file)", () => {
    const opts = {
        namespace: "default",
        secret: "shop-db",
        dryRun: true,
    };

    it("resolves the DSN from a --secret-file manifest and prints the pool contract", async () => {
        const file = join(dir, "secret.yaml");
        writeFileSync(
            file,
            ["stringData:", "  DATABASE_URL: postgres://u@h/db"].join("\n"),
        );
        const write = mock();
        await runDbBind(
            "my-app",
            { ...opts, secretFile: file },
            { exec: mock(), write },
        );
        const printed = write.mock.calls.map((c) => c[0]).join("");
        expect(printed).toContain("Connection contract");
        expect(printed).toMatch(/10\s?s/);
    });

    it("notes (does not throw) when the --secret-file cannot be read", async () => {
        const write = mock();
        await runDbBind(
            "my-app",
            { ...opts, secretFile: join(dir, "nope.yaml") },
            { exec: mock(), write },
        );
        const printed = write.mock.calls.map((c) => c[0]).join("");
        expect(printed).toMatch(/could not read --secret-file/);
    });

    it("notes when the key is absent from the --secret-file", async () => {
        const file = join(dir, "secret.yaml");
        writeFileSync(file, ["stringData:", "  OTHER: x"].join("\n"));
        const write = mock();
        await runDbBind(
            "my-app",
            { ...opts, secretFile: file },
            { exec: mock(), write },
        );
        const printed = write.mock.calls.map((c) => c[0]).join("");
        expect(printed).toMatch(/not found in/);
    });
});

describe("runDbBind — local-config cross-check (ADR-0019 rules 3/4)", () => {
    it("rejects (before any exec) when the LOCAL config's envMap already defines DATABASE_URL", async () => {
        const exec = mock();
        const write = mock();
        const localConfig = {
            secrets: {
                envMap: { DATABASE_URL: { secretName: "x", secretKey: "y" } },
            },
        };
        await expect(
            runDbBind(
                "my-app",
                { namespace: "default", secret: "shop-db", dryRun: true },
                { exec, write },
                localConfig,
            ),
        ).rejects.toThrow(/spec.database owns DATABASE_URL.*\(config\)/);
        // The local cross-check fires before the dry-run render / any exec.
        expect(exec).not.toHaveBeenCalled();
    });
});

describe("dbMain", () => {
    it("throws on an unknown subcommand", async () => {
        await expect(dbMain(["frobnicate"])).rejects.toThrow(
            /unknown db subcommand "frobnicate"/,
        );
    });

    it("delegates `migrate` to runDbMigrate", async () => {
        await dbMain(["migrate", "--dry-run"]);
        expect(runDbMigrate).toHaveBeenCalledWith(["--dry-run"]);
    });

    it("bind: resolves the positional app name and runs the dry-run patch", async () => {
        // No kn-next.config.ts in the temp cwd → app name must come from argv.
        await expect(
            dbMain(["bind", "my-app", "--secret", "shop-db", "--dry-run"]),
        ).resolves.toBeUndefined();
    });

    it("bind: throws when no app name is resolvable (no positional, no config)", async () => {
        await expect(
            dbMain(["bind", "--secret", "shop-db", "--dry-run"]),
        ).rejects.toThrow(/app name required/);
    });

    it("prints help for `bind --help` without throwing", async () => {
        await expect(dbMain(["bind", "--help"])).resolves.toBeUndefined();
    });

    it("prints the db family help for a bare `db`", async () => {
        await expect(dbMain([])).resolves.toBeUndefined();
    });
});
