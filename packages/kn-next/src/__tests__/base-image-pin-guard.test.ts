/**
 * base-image-pin-guard — supply-chain hardening (P1).
 *
 * security.md ("Supply chain") requires "Pin images by digest; reject :latest."
 * The operator's *controller* image is already guarded by hack/check-no-latest.sh,
 * but the *base* images that determine the runtime CVE surface
 * (node:22-alpine, golang:1.25.x, gcr.io/distroless/static) were floating by tag.
 *
 * scripts/check-base-images-pinned.sh is the deterministic CI guard (analogous to
 * hadolint DL3006/DL3007) that FAILS on any Dockerfile `FROM` line lacking an
 * @sha256: digest. This spec wires it into the app test suite so a future
 * un-pinning regression is caught by `vitest run`, not just in CI YAML.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// repo root: packages/kn-next/src/__tests__ -> up 4
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const GUARD = join(REPO_ROOT, "scripts", "check-base-images-pinned.sh");

/** Run the guard against an explicit list of Dockerfiles; capture exit + output. */
function runGuard(files: string[]): { code: number; out: string } {
    try {
        const out = execFileSync("bash", [GUARD, "--quiet", ...files], {
            encoding: "utf8",
        });
        return { code: 0, out };
    } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return {
            code: e.status ?? 1,
            out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
        };
    }
}

describe("base-image digest-pin guard (security.md supply chain)", () => {
    it("PASSES on the real (now-pinned) app + operator Dockerfiles", () => {
        const { code } = runGuard([
            join(REPO_ROOT, "apps", "file-manager", "Dockerfile"),
            join(REPO_ROOT, "packages", "kn-next-operator", "Dockerfile"),
        ]);
        expect(code).toBe(0);
    });

    it("FAILS on a Dockerfile with a floating (non-digest) base tag", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-pin-guard-"));
        try {
            const bad = join(dir, "Dockerfile");
            writeFileSync(bad, "FROM node:22-alpine AS builder\nRUN true\n");
            const { code, out } = runGuard([bad]);
            expect(code).toBe(1);
            expect(out).toMatch(/floating base image/i);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("PASSES on a digest-pinned FROM and exempts stage aliases + scratch", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-pin-guard-"));
        try {
            const good = join(dir, "Dockerfile");
            writeFileSync(
                good,
                [
                    "FROM node:22-alpine@sha256:" +
                        "a".repeat(64) +
                        " AS builder",
                    "FROM builder AS runner", // stage alias — exempt
                    "FROM scratch", // no external base — exempt
                ].join("\n") + "\n",
            );
            const { code } = runGuard([good]);
            expect(code).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
