/**
 * #1190 — codify the standaloneDockerignore() keep-list coverage as a
 * FAST unit test, not a docker-e2e-only proof.
 *
 * #1186 made the docker-e2e stage the standalone build context via the
 * shipped `stageStandaloneBuildContext()`, so a `.dockerignore` keep-list
 * regression reds it — but only via the SLOW docker-e2e, and #1189's
 * spec-review mutation was a manual PR-body run, never committed.
 *
 * This test SCANS `templates/runtime-standalone/Dockerfile.standalone.hbs`
 * for its `COPY <src> <dst>` lines (context-relative sources only — a
 * `COPY --from=<stage>` source is a PREVIOUS BUILD STAGE, not the build
 * CONTEXT, so it can never be excluded by a `.dockerignore` and is out of
 * scope here), extracts each `<src>`, and asserts the shipped
 * `standaloneDockerignore()` does not exclude it — evaluated the same way
 * the staging guard evaluates it, via `dockerignoreExcludes()`.
 *
 * Scanning (not enumerating) means a FUTURE COPY source added to the
 * Dockerfile is automatically covered — an enumerated list is exactly how
 * the second one gets missed (workflow.md's own stated lesson).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    dockerignoreExcludes,
    runtimeStandaloneTemplateDir,
    standaloneDockerignore,
} from "../cli/runtime-image";

/**
 * Extract the context-relative COPY sources from a Dockerfile's text.
 *
 * Handles:
 *   - `COPY <src> <dst>` — a plain build-context copy.
 *   - `COPY --from=<stage> <src> <dst>` — SKIPPED: `<src>` there resolves
 *     against a previous build STAGE's filesystem, never the build context,
 *     so no `.dockerignore` pattern can touch it.
 *   - A trailing `/` on `<src>` is normalized away so it matches the
 *     evaluator's path form (`dockerignoreExcludes` compares exact segments).
 */
function copySourcesFromDockerfile(dockerfileText: string): string[] {
    const sources: string[] = [];
    for (const rawLine of dockerfileText.split("\n")) {
        const line = rawLine.trim();
        if (!line.startsWith("COPY ")) continue;
        if (line.includes("--from=")) continue; // previous stage, not context
        const rest = line.slice("COPY ".length).trim();
        const parts = rest.split(/\s+/).filter((p) => p.length > 0);
        // A COPY line names >=2 args (src... dst); the last is the
        // destination, everything before it is a source.
        if (parts.length < 2) continue;
        const srcArgs = parts.slice(0, -1);
        for (const src of srcArgs) {
            sources.push(src.replace(/\/+$/, ""));
        }
    }
    return sources;
}

describe("#1190 — standaloneDockerignore() keeps every Dockerfile.standalone.hbs COPY source", () => {
    const dockerfilePath = join(
        runtimeStandaloneTemplateDir(),
        "Dockerfile.standalone.hbs",
    );
    const dockerfileText = readFileSync(dockerfilePath, "utf8");
    const copySources = [...new Set(copySourcesFromDockerfile(dockerfileText))];

    it("parses a non-trivial number of COPY sources out of the template (non-vacuity)", () => {
        // Guards against the scanner itself silently matching nothing (e.g. a
        // COPY-line syntax drift) and the test below passing vacuously over
        // an empty list. The template has at minimum: .next/standalone,
        // .next/static, public, node_modules/@getknext/core, and the entry
        // shim (copied to two destinations, so it appears twice pre-dedupe).
        expect(copySources.length).toBeGreaterThanOrEqual(4);
    });

    it("scan finds every documented COPY source (sanity, not the coverage assertion)", () => {
        for (const expected of [
            ".next/standalone",
            ".next/static",
            "public",
            "node_modules/@getknext/core",
            "knext-standalone-entry.mjs",
        ]) {
            expect(
                copySources,
                `scanner must have found COPY source ${expected}`,
            ).toContain(expected);
        }
    });

    it("standaloneDockerignore() does not exclude ANY parsed COPY source", () => {
        const ignoreContent = standaloneDockerignore();
        for (const src of copySources) {
            expect(
                dockerignoreExcludes(ignoreContent, src),
                `standaloneDockerignore() must NOT exclude COPY source "${src}" — ` +
                    "excluding it drops it from the build context and the image " +
                    "fails to build (the #1177 regression class)",
            ).toBe(false);
        }
    });
});

/**
 * #1327 — a FAST, CI-running guard on standaloneDockerignore()'s secret
 * patterns, so reverting `**\/.env`/`**\/.env.*`/`**\/*.pem`/etc. back to
 * their bare (root-only) form goes red HERE, not only in the slow
 * docker-e2e suite (which is not wired into `ci.yml` by this PR's sibling
 * work item — this unit test is the fast backstop for the same bug class).
 *
 * Every assertion below also exercises the `**\/` branch added to the local
 * `matchesDockerignore()` evaluator (~runtime-image.ts:560): without it,
 * NONE of the nested-path assertions here could pass no matter what
 * `standaloneDockerignore()` returns, which is exactly the false-negative
 * the #1327 review caught.
 */
describe("#1327 — standaloneDockerignore() secret patterns cover the standalone-output nesting depth", () => {
    const ignoreContent = standaloneDockerignore();

    it("excludes the .env.production Next itself copies into .next/standalone/", () => {
        expect(
            dockerignoreExcludes(
                ignoreContent,
                ".next/standalone/.env.production",
            ),
            "a bare .env.* pattern is root-only and misses this nested path — the exact #1327 leak",
        ).toBe(true);
    });

    it("still excludes a root-level .env (the original, pre-#1327 case)", () => {
        expect(dockerignoreExcludes(ignoreContent, ".env")).toBe(true);
    });

    it("keeps .env.example — the documented negation, at any depth", () => {
        expect(dockerignoreExcludes(ignoreContent, ".env.example")).toBe(false);
        expect(
            dockerignoreExcludes(
                ignoreContent,
                ".next/standalone/.env.example",
            ),
        ).toBe(false);
    });

    it("excludes a nested .pem key and a nested .npmrc, not just root-level ones", () => {
        for (const nested of [
            "config/secrets/id.pem",
            ".next/standalone/.npmrc",
        ]) {
            expect(
                dockerignoreExcludes(ignoreContent, nested),
                `standaloneDockerignore() must exclude nested credential file "${nested}"`,
            ).toBe(true);
        }
    });

    it("excludes every other secret pattern (.key, .p12, .netrc, kubeconfig, .kube/) at a nested path too", () => {
        for (const nested of [
            "a/b/id.key",
            "a/b/bundle.p12",
            "a/b/.netrc",
            "a/b/kubeconfig",
            "a/b/.kube/config",
        ]) {
            expect(
                dockerignoreExcludes(ignoreContent, nested),
                `standaloneDockerignore() must exclude nested credential path "${nested}"`,
            ).toBe(true);
        }
    });
});
