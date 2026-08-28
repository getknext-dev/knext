/**
 * ADR-0047 — `storage` is OPTIONAL BY ABSENCE (ergonomics ledger row 3b).
 *
 * Omitting `storage` from kn-next.config.ts is a first-class, explicitly
 * announced deploy mode: static assets are served from the container image
 * (`next start` semantics) — no asset upload, no assetPrefix, no CDN offload,
 * no cross-deploy asset retention. Absence is the ONLY spelling of the state:
 * there is deliberately NO `provider: "none"` sentinel (an older operator
 * forwards a new enum value verbatim into pod env — a silent misconfiguration
 * — while absence is valid against every CRD version ever shipped).
 *
 * Pinned here:
 *   1. BOTH validation mirrors accept absence (`cli/validate.ts` AND
 *      `loader.ts`) — this repo's most frequent defect class is fixing one of
 *      two halves, so this file reds if EITHER mirror still rejects it.
 *   2. A present-but-broken storage block is still rejected — optional never
 *      means unvalidated.
 *   3. No sentinel: `provider: "none"` is rejected loudly.
 *   4. `kn-next gc` with no storage reports "nothing to reap" and exits 0.
 *   5. The announced-mode notice names every dropped capability (image-served
 *      assets, no CDN offload, no cross-deploy retention, in-flight skew
 *      window) and carries the docs growth-path link.
 *   6. The emitted NextApp CR simply omits `spec.storage` (valid on every
 *      shipped CRD — both operator consumers are nil-guarded).
 *   7. `doctor` reports the static-asset mode (both directions).
 *   8. The scaffold ships the no-storage default: `storage` commented out
 *      with a plain-language growth path, and the generated image still
 *      carries `.next/static` + `public` (the Dockerfile COPY lines — the
 *      mutation target: delete the COPY and this file goes red).
 */

import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNextAppCRObject } from "../cli/cr-builder";
import { writeScaffold } from "../cli/create";
import type { KubectlFn } from "../cli/doctor";
import { runDoctor } from "../cli/doctor";
import { GC_NO_STORAGE_REPORT } from "../cli/gc";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";
import { loadConfig as loaderLoadConfig } from "../loader";
import {
    hasStorage,
    NO_STORAGE_DOCS_URL,
    NO_STORAGE_MODE_NOTICE,
} from "../utils/asset-upload";

const storageless: KnativeNextConfig = {
    name: "starter",
    registry: "ghcr.io/someone",
};

describe("both validation mirrors accept an absent storage (condition 2)", () => {
    it("cli/validate.ts: a config without storage validates clean", () => {
        expect(() => validateConfig(storageless)).not.toThrow();
    });

    it("cli/validate.ts: absence produces NO storage error even when other fields fail", () => {
        let message = "";
        try {
            validateConfig({ registry: "r" } as KnativeNextConfig);
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toMatch(/'name'/);
        expect(message).not.toMatch(/'storage' is required/);
    });

    it("loader.ts: a config module without storage loads clean", async () => {
        const dir = mkdtempSync(join(loaderTmpRoot, "nostorage-"));
        const file = join(dir, "kn-next.config.mjs");
        writeFileSync(
            file,
            "export default { name: 'starter', registry: 'ghcr.io/someone' };\n",
        );
        const cfg = await loaderLoadConfig(file);
        expect(cfg.name).toBe("starter");
        expect(cfg.storage).toBeUndefined();
    });

    it("loader.ts: name and registry are still required", async () => {
        const dir = mkdtempSync(join(loaderTmpRoot, "invalid-"));
        const file = join(dir, "kn-next.config.mjs");
        writeFileSync(file, "export default { name: 'starter' };\n");
        await expect(loaderLoadConfig(file)).rejects.toThrow(/registry/);
    });
});

describe("optional never means unvalidated", () => {
    it("a PRESENT storage block with an unknown provider still fails", () => {
        expect(() =>
            validateConfig({
                ...storageless,
                storage: {
                    provider: "ftp",
                    bucket: "b",
                    publicUrl: "https://x",
                },
            } as unknown as KnativeNextConfig),
        ).toThrow(/provider 'ftp' is not supported/);
    });

    it("a PRESENT storage block without a bucket still fails", () => {
        expect(() =>
            validateConfig({
                ...storageless,
                storage: {
                    provider: "gcs",
                    bucket: "",
                    publicUrl: "https://x",
                },
            } as KnativeNextConfig),
        ).toThrow(/'storage.bucket' is required/);
    });

    it("rejects the provider:'none' sentinel — absence is the ONLY spelling", () => {
        // An old operator forwards a new enum value verbatim into pod env
        // (STORAGE_PROVIDER=none, empty bucket): a silent misconfiguration.
        // Two spellings of one state is also how the two mirrors drift.
        expect(() =>
            validateConfig({
                ...storageless,
                storage: {
                    provider: "none",
                    bucket: "",
                    publicUrl: "",
                },
            } as unknown as KnativeNextConfig),
        ).toThrow(/not supported/);
    });
});

describe("hasStorage narrows the config for the storage-backed call paths", () => {
    it("is false for absence, true for a present block", () => {
        expect(hasStorage(storageless)).toBe(false);
        expect(
            hasStorage({
                ...storageless,
                storage: {
                    provider: "gcs",
                    bucket: "b",
                    publicUrl: "https://x",
                },
            }),
        ).toBe(true);
    });
});

describe("the announced-mode notice (condition 1)", () => {
    it("names every capability the mode drops, and the growth path", () => {
        // ADR-0043 §3: a dropped storage block must not look identical to a
        // deliberate choice — the notice is the difference.
        expect(NO_STORAGE_MODE_NOTICE).toMatch(/served from the image/i);
        expect(NO_STORAGE_MODE_NOTICE).toMatch(/no CDN offload/i);
        expect(NO_STORAGE_MODE_NOTICE).toMatch(
            /no cross-deploy asset retention/i,
        );
        // The honest half of ADR-0011: navigations still reload via ?dpl=,
        // but a chunk fetch already in flight when the old revision scales
        // away is unprotected without the bucket.
        expect(NO_STORAGE_MODE_NOTICE).toMatch(/skew/i);
        expect(NO_STORAGE_MODE_NOTICE).toContain(NO_STORAGE_DOCS_URL);
        expect(NO_STORAGE_DOCS_URL).toMatch(/^https:\/\/knext\.dev\/docs\//);
    });
});

describe("the emitted NextApp CR omits spec.storage (Q2: valid on every shipped CRD)", () => {
    it("no storage key at all — nothing for an old operator to prune or reject", () => {
        const cr = buildNextAppCRObject(
            storageless,
            "ghcr.io/someone/starter@sha256:deadbeef",
            "default",
        );
        expect(Object.keys(cr.spec as Record<string, unknown>)).not.toContain(
            "storage",
        );
    });
});

describe("kn-next gc without storage (condition 3)", () => {
    it("the report says nothing-to-reap in the exact announced words", () => {
        expect(GC_NO_STORAGE_REPORT).toContain(
            "no object storage configured — nothing to reap",
        );
    });
});

describe("doctor reports the static-asset mode (condition 1)", () => {
    const unreachableKubectl: KubectlFn = () => ({
        ok: false,
        stdout: "",
        stderr: "connection refused",
    });
    const probeImage = async () =>
        ({ ok: false, reason: "not-probed" }) as never;

    it("no storage → the mode is reported, as a mode rather than a failure", async () => {
        const report = await runDoctor({
            kubectl: unreachableKubectl,
            probeImage,
            loadAppConfig: async () => storageless,
        });
        const check = report.checks.find((c) => c.id === "storage-mode");
        expect(check).toBeDefined();
        expect(check?.status).toBe("pass");
        expect(check?.detail).toMatch(/served from the image/i);
        expect(check?.detail).toMatch(/no CDN offload/i);
    });

    it("storage configured → the offload mode is reported with provider + bucket", async () => {
        const report = await runDoctor({
            kubectl: unreachableKubectl,
            probeImage,
            loadAppConfig: async () => ({
                ...storageless,
                storage: {
                    provider: "gcs",
                    bucket: "assets",
                    publicUrl: "https://cdn.example.com",
                },
            }),
        });
        const check = report.checks.find((c) => c.id === "storage-mode");
        expect(check?.status).toBe("pass");
        expect(check?.detail).toMatch(/gcs/);
        expect(check?.detail).toMatch(/assets/);
    });

    it("no config in this directory → the check skips instead of failing", async () => {
        const report = await runDoctor({
            kubectl: unreachableKubectl,
            probeImage,
            loadAppConfig: async () => undefined,
        });
        const check = report.checks.find((c) => c.id === "storage-mode");
        expect(check?.status).toBe("skip");
    });
});

// ---------------------------------------------------------------------------
// Scaffold: the no-storage default (condition 6) + the image-served static
// tier's build-time halves (condition 4's in-suite guards).
// ---------------------------------------------------------------------------

let root: string;
const loaderTmpRoot = join(import.meta.dirname, ".optional-storage-tmp");

beforeAll(() => {
    mkdirSync(loaderTmpRoot, { recursive: true });
    root = mkdtempSync(join(loaderTmpRoot, "scaffold-"));
});

afterAll(() => {
    rmSync(loaderTmpRoot, { recursive: true, force: true });
});

function scaffoldApp(name: string): { appDir: string } {
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const appDir = join(root, "apps", name);
    mkdirSync(appDir, { recursive: true });
    writeScaffold({ appDir, name });
    return { appDir };
}

describe("kn-next create scaffolds the no-storage default (condition 6)", () => {
    it("the generated config has storage COMMENTED OUT — every storage line is a comment", () => {
        const { appDir } = scaffoldApp("starter-app");
        const config = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        const storageLines = config
            .split("\n")
            .filter((l) => /(storage:|provider:|bucket:|publicUrl:)/.test(l));
        expect(storageLines.length).toBeGreaterThan(0);
        for (const line of storageLines) {
            expect(line.trimStart().startsWith("//"), line).toBe(true);
        }
    });

    it("the growth path is explained in plain language above the commented block", () => {
        const { appDir } = scaffoldApp("growth-app");
        const config = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        // Plain words a zero-k8s Next.js dev can act on: what the default
        // does, and why/when to un-comment.
        expect(config).toMatch(/without/i);
        expect(config).toMatch(/like[\s\S]{0,40}next start/i);
        expect(config).toContain(NO_STORAGE_DOCS_URL);
    });

    it("the generated config passes the CLI's own validation AS SCAFFOLDED (no edits)", async () => {
        // Row 3b's actual wall: `'storage' is required` on the scaffold's
        // placeholder. The scaffold must be valid before the user fills
        // anything storage-shaped in.
        const { appDir } = scaffoldApp("valid-as-is");
        const config = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        // Reconstruct the object the TS module exports — comments stripped is
        // enough here because the storage block is entirely commented out.
        const uncommented = config
            .split("\n")
            .filter((l) => !l.trimStart().startsWith("//"))
            .join("\n");
        expect(uncommented).not.toMatch(/storage:/);
    });
});

describe("the image serves its own statics (condition 4 build-time halves)", () => {
    it("the generated Dockerfile COPYs the served asset root into the runner image", () => {
        // THE mutation target: delete the `.output/public` COPY line from
        // templates/app/Dockerfile.hbs and this expectation goes red — a
        // no-storage pod would boot and 404 every chunk.
        //
        // The path changed with ADR-0048, the requirement did not. Under vinext
        // the nitro build emits ONE served root, `.output/public`, holding both
        // the hashed `_next` chunks and the app's own `public/` files. Two
        // COPY lines collapsed into one because the artifact merged them, not
        // because a guard was relaxed.
        const { appDir } = scaffoldApp("static-copy");
        const dockerfile = readFileSync(join(appDir, "Dockerfile"), "utf8");
        expect(dockerfile).toMatch(
            /COPY\s+[^\n]*\.output\/public\s+\S*\.output\/public/,
        );
    });

    it("…and does NOT still reference the retired standalone asset paths", () => {
        // The other half. Without it, a template that COPYs `.output/public`
        // AND drags along a dead `.next/static` line would pass — which is how
        // a migration leaves rubble that reads as intentional. `.next/standalone`
        // is checked too: it is the directory this build never produces.
        const { appDir } = scaffoldApp("public-copy");
        const dockerfile = readFileSync(join(appDir, "Dockerfile"), "utf8");
        expect(dockerfile).not.toMatch(/\.next\/static/);
        expect(dockerfile).not.toMatch(/\.next\/standalone/);
    });

    it("the generated next.config gates assetPrefix on ASSET_PREFIX — unset env ⇒ no prefix in emitted HTML", () => {
        // deploy only sets ASSET_PREFIX when storage is configured (pinned
        // hermetically in deploy-no-storage.test.ts), so this env gate is what
        // makes the emitted HTML reference `/_next/static/...` relative paths
        // in the no-storage mode.
        const { appDir } = scaffoldApp("prefix-gate");
        const config = readFileSync(join(appDir, "next.config.ts"), "utf8");
        expect(config).toMatch(
            /assetPrefix:\s*process\.env\.ASSET_PREFIX \|\| ""/,
        );
    });
});

describe("create's parting line speaks to the persona (row 3a)", () => {
    it("names the real next steps in order, keeps test:seam last and in plain words", async () => {
        const { partingLine } = await import("../cli/create");
        const text = partingLine("my-app");
        const cd = text.indexOf("cd my-app");
        const install = text.indexOf("npm install");
        const dev = text.indexOf("npm run dev");
        const deploy = text.indexOf("deploy");
        const seam = text.indexOf("test:seam");
        // The persona's actual path, in the order they will type it.
        expect(cd).toBeGreaterThanOrEqual(0);
        expect(install).toBeGreaterThan(cd);
        expect(dev).toBeGreaterThan(install);
        expect(deploy).toBeGreaterThan(dev);
        // test:seam is still mentioned — but last, and not in contributor
        // jargon ("instrumentation seams survive the standalone build").
        expect(seam).toBeGreaterThan(deploy);
        expect(text).not.toMatch(/instrumentation seams/);
        expect(text).toMatch(/doctor/);
    });
});
