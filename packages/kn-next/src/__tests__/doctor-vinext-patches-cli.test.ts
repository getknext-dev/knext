/**
 * End to end: `knext doctor` run from an app directory that has vinext 1.0.1
 * installed reports the vinext-patches row. The unit tests inject the installed
 * version; this one goes through the REAL dispatcher and the real default
 * lookup, so a doctorMain that stops wiring the lookup reds here.
 */

import { describe, expect, it, setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);

import { spawnSync } from "node:child_process";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(resolve(here, "..", ".."), "src", "cli", "deploy.ts");
const bun = process.env.BUN_PATH ?? "bun";

function doctorIn(vinextVersion: string | undefined) {
    const fakeBin = mkdtempSync(join(tmpdir(), "knext-fake-kubectl-"));
    writeFileSync(join(fakeBin, "kubectl"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(fakeBin, "kubectl"), 0o755);
    const app = mkdtempSync(join(tmpdir(), "knext-doctor-vp-cli-"));
    try {
        if (vinextVersion !== undefined) {
            const dir = join(app, "node_modules", "vinext");
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "vinext", version: vinextVersion }),
            );
        }
        const env = { ...process.env };
        delete env.KNEXT_VINEXT_PATCHES;
        const r = spawnSync(bun, [entry, "doctor", "--json"], {
            encoding: "utf8",
            cwd: app,
            env: {
                ...env,
                NO_COLOR: "1",
                PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
                KUBECONFIG: join(app, "does-not-exist"),
            },
        });
        const parsed = JSON.parse(r.stdout) as {
            checks: { id: string; status: string; hint?: string }[];
        };
        return { status: r.status, checks: parsed.checks };
    } finally {
        rmSync(fakeBin, { recursive: true, force: true });
        rmSync(app, { recursive: true, force: true });
    }
}

describe("knext doctor, run from an app directory", () => {
    it("reports a FAIL row with a repair hint for a vinext 1.0.1 install, and exits 1", () => {
        const r = doctorIn("1.0.1");
        const row = r.checks.find((c) => c.id === "vinext-patches");
        expect(row?.status).toBe("fail");
        expect(row?.hint).toContain("vinext@");
        expect(r.status).toBe(1);
    });

    it("adds no vinext row for a directory without vinext", () => {
        const r = doctorIn(undefined);
        expect(r.checks.some((c) => c.id === "vinext-patches")).toBe(false);
    });
});
