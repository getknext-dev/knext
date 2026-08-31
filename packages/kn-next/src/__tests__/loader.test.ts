/**
 * loader.ts — loadConfig(path): dynamic-import a kn-next config module and
 * validate the minimal required shape (name/storage/registry). These pin the
 * error branches (missing file, no default export, invalid config) and the
 * happy path, using a real temp .mjs module so the dynamic import is genuine.
 */

import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../loader";

let dir: string;
const savedCwd = process.cwd();
// Temp configs live UNDER the repo root (this test dir) so vitest's dynamic-import
// pipeline can resolve the absolute path loadConfig hands to `import()` — a path
// under the OS tmpdir is outside Vite's root and fails to resolve.
const tmpRoot = join(import.meta.dirname, ".loader-tmp");

beforeAll(() => {
    mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
    dir = mkdtempSync(join(tmpRoot, "cfg-"));
    process.chdir(dir);
});

afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

/** Write a config module (ESM) into the temp cwd and return its rel path. */
function writeConfigModule(body: string, name = "kn-next.config.mjs"): string {
    writeFileSync(join(dir, name), body, "utf-8");
    return name;
}

describe("loadConfig (loader.ts)", () => {
    it("throws when the config file does not exist", async () => {
        await expect(loadConfig("does-not-exist.mjs")).rejects.toThrow(
            /Configuration file not found/,
        );
    });

    it("throws when the module has no default export", async () => {
        const rel = writeConfigModule("export const notDefault = 1;\n");
        await expect(loadConfig(rel)).rejects.toThrow(/default export/);
    });

    it("throws when required fields are missing", async () => {
        const rel = writeConfigModule(
            "export default { name: 'x' };\n", // no registry (storage is optional, ADR-0047)
        );
        await expect(loadConfig(rel)).rejects.toThrow(
            /'name' and 'registry' are required/,
        );
    });

    it("returns the config when name/storage/registry are present", async () => {
        const rel = writeConfigModule(
            [
                "export default {",
                "  name: 'my-app',",
                "  registry: 'reg.example.com',",
                "  storage: { provider: 'gcs', bucket: 'b' },",
                "};",
            ].join("\n"),
        );
        const config = await loadConfig(rel);
        expect(config.name).toBe("my-app");
        expect(config.registry).toBe("reg.example.com");
        expect(config.storage?.bucket).toBe("b");
    });

    it("wraps a module-evaluation error with the file path", async () => {
        const rel = writeConfigModule("throw new Error('boom in config');\n");
        await expect(loadConfig(rel)).rejects.toThrow(
            /Failed to load config from .*boom in config/,
        );
    });
});
