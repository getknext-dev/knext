/**
 * shared.ts — loadConfig() (the single source of truth CLI config loader) and
 * excerpt(). loadConfig reads kn-next.config.ts from cwd and runs validateConfig.
 * A temp cwd UNDER the repo root keeps the dynamic import resolvable by vitest.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
} from "vitest";
import { excerpt, loadConfig } from "../cli/shared";

const tmpRoot = join(import.meta.dirname, ".shared-tmp");
let dir: string;
const savedCwd = process.cwd();

beforeAll(() => mkdirSync(tmpRoot, { recursive: true }));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
    dir = mkdtempSync(join(tmpRoot, "cfg-"));
    process.chdir(dir);
});
afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

describe("excerpt", () => {
    it("collapses whitespace and caps length", () => {
        expect(excerpt("  a\n\tb   c  ")).toBe("a b c");
        expect(excerpt("x".repeat(200))).toHaveLength(160);
    });
});

describe("loadConfig (shared.ts)", () => {
    it("throws when kn-next.config.ts is absent in cwd", async () => {
        await expect(loadConfig()).rejects.toThrow(/Config file not found/);
    });

    it("loads and validates a well-formed config", async () => {
        writeFileSync(
            join(dir, "kn-next.config.ts"),
            [
                "export default {",
                "  name: 'my-app',",
                "  registry: 'reg.example.com',",
                "  storage: { provider: 'gcs', bucket: 'b', publicUrl: 'https://x' },",
                "};",
            ].join("\n"),
            "utf-8",
        );
        const config = await loadConfig();
        expect(config.name).toBe("my-app");
    });
});
