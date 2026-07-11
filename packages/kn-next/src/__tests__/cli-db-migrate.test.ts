/**
 * `kn-next db migrate` — the one-shot, writer-only migration runner (ADR-0021 §3).
 *
 * The subcommand applies drizzle-kit-generated migrations against the WRITER
 * `DATABASE_URL` exactly once per deploy (a CI step or a k8s Job), out of the
 * request path. These tests pin the arg surface and the runner wiring — the
 * migration engine itself lives in `@knext/db/migrate` and is injected here, so
 * no database is touched. The writer-only + fail-loud guarantees are proven in
 * `@knext/db`'s own `migrate.test.ts` (`runMigrations`/`resolveWriterDsn`).
 */

import { describe, expect, it, vi } from "vitest";
import {
    type DbMigrateOptions,
    type MigrateRunner,
    parseDbMigrateArgs,
    runDbMigrate,
} from "../cli/db-migrate";

describe("parseDbMigrateArgs", () => {
    it("defaults to no overrides (writer DATABASE_URL + ./drizzle resolved downstream)", () => {
        const o = parseDbMigrateArgs([]);
        expect(o).toEqual({});
    });

    it("parses --url and --dir", () => {
        const o = parseDbMigrateArgs([
            "--url",
            "postgres://writer:55432/app",
            "--dir",
            "./migrations",
        ]);
        expect(o.url).toBe("postgres://writer:55432/app");
        expect(o.migrationsFolder).toBe("./migrations");
    });

    it("accepts --migrations as an alias for --dir", () => {
        const o = parseDbMigrateArgs(["--migrations", "./sql"]);
        expect(o.migrationsFolder).toBe("./sql");
    });

    it("rejects a value-taking flag with no value", () => {
        expect(() => parseDbMigrateArgs(["--url"])).toThrow(/requires a value/);
        expect(() => parseDbMigrateArgs(["--url", "--dir"])).toThrow(
            /requires a value/,
        );
    });

    it("rejects unknown flags (a typo must not silently migrate with defaults)", () => {
        expect(() => parseDbMigrateArgs(["--dsn", "x"])).toThrow(
            /unknown flag/,
        );
    });

    it("rejects stray positionals", () => {
        expect(() => parseDbMigrateArgs(["oops"])).toThrow(/positional/);
    });
});

describe("runDbMigrate", () => {
    function deps(runImpl?: MigrateRunner) {
        const run = vi.fn<MigrateRunner>(
            runImpl ??
                (async (o) => ({
                    migrationsFolder: o.migrationsFolder ?? "./drizzle",
                })),
        );
        const written: string[] = [];
        const write = (t: string) => {
            written.push(t);
        };
        return { run, write, written };
    }

    it("invokes the injected runner with the parsed writer DSN + folder", async () => {
        const { run, write, written } = deps();
        await runDbMigrate(
            ["--url", "postgres://writer:55432/app", "--dir", "./migrations"],
            run,
            write,
        );
        expect(run).toHaveBeenCalledWith({
            url: "postgres://writer:55432/app",
            migrationsFolder: "./migrations",
        });
        expect(written.join("")).toMatch(/migrations|applied/i);
    });

    it("propagates a runner failure (fail loud — the Job must exit non-zero)", async () => {
        const boom = new Error("connection refused");
        const { run, write } = deps(async () => {
            throw boom;
        });
        await expect(runDbMigrate([], run, write)).rejects.toThrow(boom);
    });

    it("prints help and does not run when -h is passed", async () => {
        const { run, write, written } = deps();
        await runDbMigrate(["-h"], run, write);
        expect(run).not.toHaveBeenCalled();
        expect(written.join("")).toMatch(/db migrate/);
    });

    it("carries the DbMigrateOptions type", () => {
        const o: DbMigrateOptions = { url: "x", migrationsFolder: "y" };
        expect(o.url).toBe("x");
    });
});
