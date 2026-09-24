/**
 * #1378 (item 3) — `kn-next build` on the default (standalone) target writes
 * a ~60-90 MB compiled binary, `knext-standalone-exec-<arch>`
 * (`STANDALONE_EXEC_BASENAME`, `cli/standalone-exec-build.ts`), into the app
 * (or repo, for this repo's own dev builds) root. The pre-existing
 * `knext-exec*` ignore patterns — this repo's own root `.gitignore`, the
 * scaffold's `.dockerignore.hbs`, and `Dockerfile.vinext-node.dockerignore.hbs`
 * — were all written for the OTHER, unrelated `knext-exec-<arch>` vinext
 * single-executable binary (ADR-0048). `knext-exec*` does NOT match
 * `knext-standalone-exec-linux-x64`: that string does not start with the
 * literal substring `knext-exec`, so every one of those ignore surfaces
 * silently misses the newer binary — proved below with the same simple
 * glob semantics dockerignore/gitignore use for a slash-free pattern
 * (`*` matches any run of non-slash characters, full-string match).
 *
 * `standaloneDockerignore()` (`runtime-image.ts`, ADR-0055) is deliberately
 * NOT touched here: `Dockerfile.standalone.hbs` COPYs this exact binary out
 * of the context it bounds, so it must keep NOT excluding it. That is
 * asserted too, as a regression guard in the opposite direction.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { standaloneDockerignore } from "../cli/runtime-image";
import { standaloneExecFileName } from "../cli/standalone-exec-build";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");

/** The real ship-binary basename this repo/scaffold actually produces. */
const BINARY = standaloneExecFileName("linux-x64");

/**
 * Minimal slash-free glob → regex, matching gitignore/dockerignore semantics
 * for a bare pattern (no `/`): `*` matches any run of non-slash characters,
 * the whole basename must match. Good enough for the single-segment
 * patterns this test reads; not a general gitignore engine.
 */
function globMatches(pattern: string, name: string): boolean {
    const re = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
    );
    return re.test(name);
}

/** Every non-comment, non-negation pattern line in an ignore file's text. */
function excludePatterns(text: string): string[] {
    return text
        .split("\n")
        .map((l) => l.trim())
        .filter(
            (l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"),
        );
}

function isExcluded(text: string, name: string): boolean {
    return excludePatterns(text).some((p) => globMatches(p, name));
}

describe("#1378: knext-standalone-exec-* ignore coverage", () => {
    it("this repo's root .gitignore excludes the standalone-exec binary", () => {
        const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
        expect(isExcluded(gitignore, BINARY)).toBe(true);
    });

    it("the scaffold's .dockerignore.hbs (paired with vinext Dockerfile.hbs) excludes it", () => {
        const dockerignore = readFileSync(
            join(PKG_ROOT, "templates", "app", ".dockerignore.hbs"),
            "utf8",
        );
        expect(isExcluded(dockerignore, BINARY)).toBe(true);
    });

    it("Dockerfile.vinext-node.dockerignore.hbs excludes it", () => {
        const dockerignore = readFileSync(
            join(
                PKG_ROOT,
                "templates",
                "app",
                "Dockerfile.vinext-node.dockerignore.hbs",
            ),
            "utf8",
        );
        expect(isExcluded(dockerignore, BINARY)).toBe(true);
    });

    it("regression guard: standaloneDockerignore() (ADR-0055) does NOT exclude it — Dockerfile.standalone.hbs COPYs it", () => {
        expect(isExcluded(standaloneDockerignore(), BINARY)).toBe(false);
    });
});
