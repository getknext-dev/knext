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
 * silently misses the newer binary — proved below with
 * `dockerignoreExcludes` (`runtime-image.ts`), the repo's own real
 * dockerignore evaluator (comment/blank skip, `!` negation, last-match-wins,
 * directory and glob patterns) — rev-1393 review: a hand-rolled matcher here
 * that ignored `!` negation would go green even if a `!knext-standalone-
 * exec-linux-*` re-include line were added right after the exclude, which is
 * exactly the shape the real `.dockerignore.hbs`'s `knext-exec*`/
 * `!knext-exec-linux-*` pair already uses for the OTHER binary.
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
import {
    dockerignoreExcludes,
    standaloneDockerignore,
} from "../cli/runtime-image";
import { standaloneExecFileName } from "../cli/standalone-exec-build";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");

/** The real ship-binary basename this repo/scaffold actually produces. */
const BINARY = standaloneExecFileName("linux-x64");

describe("#1378: knext-standalone-exec-* ignore coverage", () => {
    it("this repo's root .gitignore excludes the standalone-exec binary", () => {
        const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
        expect(dockerignoreExcludes(gitignore, BINARY)).toBe(true);
    });

    it("the scaffold's .dockerignore.hbs (paired with vinext Dockerfile.hbs) excludes it", () => {
        const dockerignore = readFileSync(
            join(PKG_ROOT, "templates", "app", ".dockerignore.hbs"),
            "utf8",
        );
        expect(dockerignoreExcludes(dockerignore, BINARY)).toBe(true);
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
        expect(dockerignoreExcludes(dockerignore, BINARY)).toBe(true);
    });

    it("regression guard: standaloneDockerignore() (ADR-0055) does NOT exclude it — Dockerfile.standalone.hbs COPYs it", () => {
        expect(dockerignoreExcludes(standaloneDockerignore(), BINARY)).toBe(
            false,
        );
    });

    it("#1393: a trailing `!<binary>` re-include line would be caught (proves the evaluator honors negation, unlike the earlier hand-rolled matcher)", () => {
        const dockerignore = readFileSync(
            join(PKG_ROOT, "templates", "app", ".dockerignore.hbs"),
            "utf8",
        );
        expect(
            dockerignoreExcludes(`${dockerignore}\n!${BINARY}\n`, BINARY),
        ).toBe(false);
    });
});
