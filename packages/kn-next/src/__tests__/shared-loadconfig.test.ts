/**
 * shared.ts — loadConfig() (the single source of truth CLI config loader) and
 * excerpt(). loadConfig reads knext.config.ts from cwd and runs validateConfig.
 * No dual-read (#1559): a directory that only has the pre-rename
 * kn-next.config.ts gets LegacyConfigFileError, never a silent fallback read.
 * A temp cwd UNDER the repo root keeps the dynamic import resolvable by vitest.
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
import {
    CONFIG_NOT_FOUND_CODE,
    excerpt,
    LEGACY_CONFIG_FILE_CODE,
    loadConfig,
} from "../cli/shared";

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
    it("throws when neither knext.config.ts nor kn-next.config.ts is present", async () => {
        const err = await loadConfig().then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/Config file not found/);
        expect((err as { code?: string }).code).toBe(CONFIG_NOT_FOUND_CODE);
    });

    it("loads and validates a well-formed knext.config.ts", async () => {
        writeFileSync(
            join(dir, "knext.config.ts"),
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

    it("rejects with LEGACY_CONFIG_FILE_CODE when only the pre-rename file exists (no dual-read)", async () => {
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
        const err = await loadConfig().then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe(LEGACY_CONFIG_FILE_CODE);
        expect((err as { legacyPath?: string }).legacyPath).toContain(
            "kn-next.config.ts",
        );
    });

    it("prefers knext.config.ts silently when both filenames are present", async () => {
        writeFileSync(
            join(dir, "knext.config.ts"),
            [
                "export default {",
                "  name: 'new-name-wins',",
                "  registry: 'reg.example.com',",
                "  storage: { provider: 'gcs', bucket: 'b', publicUrl: 'https://x' },",
                "};",
            ].join("\n"),
            "utf-8",
        );
        writeFileSync(
            join(dir, "kn-next.config.ts"),
            [
                "export default {",
                "  name: 'old-name-should-not-load',",
                "  registry: 'reg.example.com',",
                "  storage: { provider: 'gcs', bucket: 'b', publicUrl: 'https://x' },",
                "};",
            ].join("\n"),
            "utf-8",
        );
        const config = await loadConfig();
        expect(config.name).toBe("new-name-wins");
    });
});
