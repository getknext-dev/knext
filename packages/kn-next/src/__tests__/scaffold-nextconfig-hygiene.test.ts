/**
 * #1378 (item 2) — content hygiene for `next.config.ts`, the one scaffold
 * file a user is most likely to actually read and edit.
 *
 * The rendered `next.config.ts` a `kn-next create` app ships with is
 * USER-FACING: its comments carried leftover internal references (`#93`,
 * `#342`, `#342/#356`, bare `ADR-00xx` shorthand) that mean nothing to a
 * reader with no access to this repo's issue tracker or ADR set — the same
 * class of defect `apps/docs/content-hygiene.test.ts` already guards for the
 * docs site. This is the CLI-template analogue, scoped to the two rendered
 * variants of `next.config.ts` (the default builder and its `--builder
 * vinext` override) rather than the whole `templates/app` tree — the issue
 * named this file specifically; the wider template tree is a separate,
 * NOT-yet-done follow-up (several other `.hbs` files under `templates/app`
 * still carry internal refs — see the PR body).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const TEMPLATES = join(PKG_ROOT, "templates", "app");

const FILES = ["next.config.ts.hbs", "next.config.ts.vinext.hbs"] as const;

/** Every `file:line` whose text matches `re`. */
function hits(re: RegExp): string[] {
    const out: string[] = [];
    for (const file of FILES) {
        const lines = readFileSync(join(TEMPLATES, file), "utf8").split("\n");
        lines.forEach((line, i) => {
            if (re.test(line)) out.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    return out;
}

describe("scaffolded next.config.ts — content hygiene (#1378)", () => {
    it("both variants exist and are readable", () => {
        for (const file of FILES) {
            expect(() =>
                readFileSync(join(TEMPLATES, file), "utf8"),
            ).not.toThrow();
        }
    });

    it("contains no bare ADR references", () => {
        expect(hits(/\bADR-?\s?\d/i)).toEqual([]);
    });

    it("contains no issue or PR numbers", () => {
        expect(hits(/(?:\bPR |\bissue |\(|\s)#\d+\b/i)).toEqual([]);
    });
});
