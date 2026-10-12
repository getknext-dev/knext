/**
 * Production `DoctorDeps` never sets `loadAppConfig`, so the doctor row must
 * come from the DEFAULT loader. Nothing is injected here: a real temp-dir
 * knext config + next.config, read through the real loaders.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KubectlFn, type ProbeOutcome, runDoctor } from "../cli/doctor";

const noKubectl: KubectlFn = () => ({ ok: false, stdout: "", stderr: "x" });
const okProbe = async (): Promise<ProbeOutcome> => "ok";

let dir: string;
const saved = process.cwd();
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-frag-doc-"));
    process.chdir(dir);
});
afterEach(() => {
    process.chdir(saved);
    rmSync(dir, { recursive: true, force: true });
});

const setup = (runtime: string) => {
    writeFileSync(
        join(dir, "knext.config.ts"),
        `export default { name: "a", registry: "r", build: "turbopack", runtime: "${runtime}" };`,
    );
    writeFileSync(
        join(dir, "next.config.ts"),
        "export default { experimental: { turbopackModuleFragments: true } };",
    );
};
const row = async () =>
    (await runDoctor({ kubectl: noKubectl, probeImage: okProbe })).checks.find(
        (c) => c.id === "turbopack-fragments-bun",
    );

describe("doctor turbopack-fragments row, default loaders", () => {
    it("fires from a real config with no injected deps", async () => {
        setup("bun");
        expect((await row())?.status).toBe("fail");
    });
    it("stays silent on node", async () => {
        setup("node");
        expect(await row()).toBeUndefined();
    });
});
