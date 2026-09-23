/**
 * file-manager Dockerfile — ASSET_PREFIX / NEXT_DEPLOYMENT_ID build-arg wiring
 * (#1283, option (a)).
 *
 * `apps/file-manager/Dockerfile` rebuilds the app INSIDE the image (`RUN
 * ./node_modules/.bin/vite build`) rather than copying host-built artifacts
 * like the scaffolded template — so unlike the template, it never saw the
 * host's `NEXT_DEPLOYMENT_ID`/`ASSET_PREFIX` env before `kn-next deploy`'s
 * general in-image-build fix (`dockerBuildxArgs` passing them as
 * `--build-arg`s, `runtime-image.ts`). Passing the build-arg is necessary but
 * NOT sufficient — the Dockerfile must also declare the `ARG` and export it
 * into the build step's env (`ENV … = ${…}`, since `vite build` reads
 * `process.env`, not Docker build-args directly). This is the text-level
 * check; `verifyBuiltImageLockstep` (asset-upload.ts) is the mutation-proof
 * check on the ACTUAL built image.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const DOCKERFILE = resolve(REPO_ROOT, "apps", "file-manager", "Dockerfile");
const text = readFileSync(DOCKERFILE, "utf-8");

describe("apps/file-manager/Dockerfile — #1283 build-arg wiring", () => {
    it("declares ARG NEXT_DEPLOYMENT_ID", () => {
        expect(text).toMatch(/^ARG NEXT_DEPLOYMENT_ID\s*$/m);
    });

    it("declares ARG ASSET_PREFIX", () => {
        expect(text).toMatch(/^ARG ASSET_PREFIX\s*$/m);
    });

    it("exports NEXT_DEPLOYMENT_ID into the build step's ENV", () => {
        expect(text).toMatch(
            /^ENV NEXT_DEPLOYMENT_ID=\$\{NEXT_DEPLOYMENT_ID\}\s*$/m,
        );
    });

    it("exports ASSET_PREFIX into the build step's ENV", () => {
        expect(text).toMatch(/^ENV ASSET_PREFIX=\$\{ASSET_PREFIX\}\s*$/m);
    });

    it("both ARGs are declared and exported BEFORE the vite build step — a declaration after the build would be inert", () => {
        const buildIdx = text.indexOf("RUN ./node_modules/.bin/vite build");
        expect(buildIdx).toBeGreaterThan(-1);
        const argNextIdx = text.indexOf("ARG NEXT_DEPLOYMENT_ID");
        const argAssetIdx = text.indexOf("ARG ASSET_PREFIX");
        const envNextIdx = text.indexOf(
            "ENV NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}",
        );
        const envAssetIdx = text.indexOf("ENV ASSET_PREFIX=${ASSET_PREFIX}");
        for (const idx of [argNextIdx, argAssetIdx, envNextIdx, envAssetIdx]) {
            expect(idx).toBeGreaterThan(-1);
            expect(idx).toBeLessThan(buildIdx);
        }
    });
});
