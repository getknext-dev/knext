/**
 * #1342 (ADR-0058) — `kn-next create` defaults to the STANDALONE target
 * (plain `next build`, `output: 'standalone'`, the official Next.js
 * Deployment Adapter) now that #1183/ADR-0058 flipped `DEFAULT_BUILDER_ID`
 * to `"turbopack"`. `--builder vinext` scaffolds the previous shape (the
 * compiled single-executable target) unchanged.
 *
 * `create-scaffold.test.ts` already covers each shape's internals in depth
 * (via `scaffoldApp()`/`scaffoldVinextApp()`); this file is the FOCUSED
 * acceptance-criteria pin for #1342 itself — which files each target emits,
 * that the two never mix, and that `selectBuilderTemplates` (the mechanism
 * behind the split) is order-independent.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createMain,
    loadTemplates,
    selectBuilderTemplates,
    writeScaffold,
} from "../cli/create";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knext-create-builder-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function scaffold(
    name: string,
    builder?: "default" | "vinext",
): { appDir: string; files: Map<string, string> } {
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const appDir = join(root, "apps", name);
    mkdirSync(appDir, { recursive: true });
    const files = writeScaffold({ appDir, name, builder });
    return { appDir, files };
}

describe("kn-next create — default target is standalone (#1342/ADR-0058)", () => {
    it("emits output:'standalone' and adapterPath in next.config.ts", () => {
        const { appDir } = scaffold("std-default");
        const src = readFileSync(join(appDir, "next.config.ts"), "utf8");
        expect(src).toMatch(/output:\s*['"]standalone['"]/);
        expect(src).toMatch(/adapterPath\s*:/);
    });

    it("emits next-adapter.ts re-exporting the official adapter", () => {
        const { appDir } = scaffold("std-adapter");
        const src = readFileSync(join(appDir, "next-adapter.ts"), "utf8");
        expect(src).toContain("@getknext/core/adapter");
    });

    it("package.json builds with plain `next build`, not vite/vinext", () => {
        const { appDir } = scaffold("std-pkg");
        const pkg = JSON.parse(
            readFileSync(join(appDir, "package.json"), "utf8"),
        ) as { scripts?: Record<string, string> };
        expect(pkg.scripts?.build).toBe("next build");
        expect(pkg.scripts?.build).not.toContain("vite");
        expect(pkg.scripts?.dev).toBe("next dev");
    });

    it("kn-next.config.ts pins no `build` — an absent build means turbopack (ADR-0058)", () => {
        const { appDir } = scaffold("std-config");
        const src = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        // Strip comments first: the template's OWN prose mentions
        // `build: 'vinext'` as the --builder vinext alternative, which a raw
        // grep would match on its own explanation.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
        expect(code).not.toMatch(/build:\s*["']vinext["']/);
    });

    it("emits NO Dockerfile — kn-next build/deploy stage the standalone runtime image automatically", () => {
        // The same rationale runtime-image.ts already documents for why the
        // standalone recipe stays OUT of templates/app: staging it here would
        // ship a scaffold-time copy that build-time silently overwrites
        // anyway (stageStandaloneBuildContext always rewrites, unlike
        // stageVinextNodeDockerfile's existsSync guard).
        const { appDir, files } = scaffold("std-no-dockerfile");
        expect(existsSync(join(appDir, "Dockerfile"))).toBe(false);
        expect(existsSync(join(appDir, ".dockerignore"))).toBe(false);
        expect([...files.keys()]).not.toContain("Dockerfile");
        expect([...files.keys()]).not.toContain("vite.config.ts");
    });

    it("emits no vinext-only files: knext-bun-entry.mjs, runtime-contract.mjs, knext-node-entry.mjs", () => {
        // Avoids the exact false-positive-noise class #1356's doctor check
        // had to special-case for knext-node-entry.mjs — by construction,
        // for every vinext-only file, not just that one.
        const { appDir } = scaffold("std-no-vinext-noise");
        for (const f of [
            "knext-bun-entry.mjs",
            "runtime-contract.mjs",
            "knext-node-entry.mjs",
            "Dockerfile.vinext-node",
        ]) {
            expect(
                existsSync(join(appDir, f)),
                `${f} should not be emitted`,
            ).toBe(false);
        }
    });
});

describe("kn-next create --builder vinext — unchanged shape (#1342)", () => {
    it("emits the vinext Dockerfile, vite.config.ts and the bun entry", () => {
        const { appDir } = scaffold("vinext-shape", "vinext");
        expect(existsSync(join(appDir, "Dockerfile"))).toBe(true);
        expect(existsSync(join(appDir, "vite.config.ts"))).toBe(true);
        expect(existsSync(join(appDir, "knext-bun-entry.mjs"))).toBe(true);
        expect(existsSync(join(appDir, "runtime-contract.mjs"))).toBe(true);
    });

    it("kn-next.config.ts pins build: 'vinext' explicitly", () => {
        const { appDir } = scaffold("vinext-config", "vinext");
        const src = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        expect(src).toMatch(/build:\s*["']vinext["']/);
    });

    it("package.json builds with `vite build`, not `next build`", () => {
        const { appDir } = scaffold("vinext-pkg", "vinext");
        const pkg = JSON.parse(
            readFileSync(join(appDir, "package.json"), "utf8"),
        ) as { scripts?: Record<string, string> };
        expect(pkg.scripts?.build).toBe("vite build");
    });

    it("next.config.ts has neither output:'standalone' nor adapterPath", () => {
        const { appDir } = scaffold("vinext-nextconfig", "vinext");
        const src = readFileSync(join(appDir, "next.config.ts"), "utf8");
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
        expect(code).not.toMatch(/output:\s*['"]standalone['"]/);
        expect(code).not.toMatch(/adapterPath\s*:/);
    });

    it("emits no next-adapter.ts — inert under vinext, which never calls adapter hooks", () => {
        const { appDir } = scaffold("vinext-no-adapter", "vinext");
        expect(existsSync(join(appDir, "next-adapter.ts"))).toBe(false);
    });
});

describe("kn-next create --builder — CLI flag validation", () => {
    async function capture(
        argv: string[],
    ): Promise<{ code: number; err: string }> {
        let err = "";
        const orig = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => {
            err += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const code = await createMain(argv);
            return { code, err };
        } finally {
            process.stderr.write = orig;
        }
    }

    it("rejects an unrecognised --builder value rather than silently defaulting", async () => {
        const appDir = join(root, "apps", "bad-builder");
        mkdirSync(appDir, { recursive: true });
        const { code, err } = await capture([
            appDir,
            "--builder",
            "vinetx", // typo — must NOT silently fall back to "default"
        ]);
        expect(code).toBe(1);
        expect(err).toContain("--builder");
        expect(existsSync(join(appDir, "package.json"))).toBe(false);
    });

    it("accepts --builder default explicitly", async () => {
        const appDir = join(root, "apps", "explicit-default");
        mkdirSync(appDir, { recursive: true });
        const { code } = await capture([appDir, "--builder", "default"]);
        expect(code).toBe(0);
        expect(existsSync(join(appDir, "Dockerfile"))).toBe(false);
    });
});

describe("selectBuilderTemplates — order-independent (#1342)", () => {
    it("the vinext override wins for builder:'vinext' regardless of Map iteration order", () => {
        // Insert the OVERRIDE before the base entry — the opposite of
        // whatever readdirSync's alphabetical-ish order would normally give,
        // to prove the selection does not depend on it.
        const templates = new Map<string, string>([
            ["next.config.ts.vinext", "VINEXT CONTENT"],
            ["next.config.ts", "DEFAULT CONTENT"],
        ]);
        const vinext = selectBuilderTemplates(templates, "vinext");
        const def = selectBuilderTemplates(templates, "default");
        expect(vinext.get("next.config.ts")).toBe("VINEXT CONTENT");
        expect(vinext.has("next.config.ts.vinext")).toBe(false);
        expect(def.get("next.config.ts")).toBe("DEFAULT CONTENT");
    });

    it("a vinext-only file is present for builder:'vinext' and absent for builder:'default'", () => {
        const templates = new Map<string, string>([
            ["Dockerfile", "FROM alpine"],
        ]);
        expect(
            selectBuilderTemplates(templates, "vinext").has("Dockerfile"),
        ).toBe(true);
        expect(
            selectBuilderTemplates(templates, "default").has("Dockerfile"),
        ).toBe(false);
    });

    it("a default-only file is present for builder:'default' and absent for builder:'vinext'", () => {
        const templates = new Map<string, string>([
            ["next-adapter.ts", "export default adapter;"],
        ]);
        expect(
            selectBuilderTemplates(templates, "default").has("next-adapter.ts"),
        ).toBe(true);
        expect(
            selectBuilderTemplates(templates, "vinext").has("next-adapter.ts"),
        ).toBe(false);
    });

    it("a shared file with no variant is present for both builders, unchanged", () => {
        const templates = new Map<string, string>([
            ["src/app/page.tsx", "export default function Page() {}"],
        ]);
        expect(
            selectBuilderTemplates(templates, "default").get(
                "src/app/page.tsx",
            ),
        ).toBe("export default function Page() {}");
        expect(
            selectBuilderTemplates(templates, "vinext").get("src/app/page.tsx"),
        ).toBe("export default function Page() {}");
    });
});

describe("kn-next create — the real shipped templates load through selectBuilderTemplates without throwing", () => {
    it("loadTemplates() + selectBuilderTemplates() resolve for both builders", () => {
        const all = loadTemplates();
        expect(selectBuilderTemplates(all, "default").size).toBeGreaterThan(0);
        expect(selectBuilderTemplates(all, "vinext").size).toBeGreaterThan(0);
    });
});
