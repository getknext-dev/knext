/**
 * `KNEXT_BUN_BASE_EXE` — the CI-only seam that points a compile at a patched
 * Bun base executable (the `infra/bun-base/` pipeline) instead of the Bun
 * running the compile script.
 *
 * CI-verification only. The patched base exists to TEST upstream Bun fixes
 * against knext's compile before they are released; it is never shipped to
 * users. That is why the seam is an environment variable and nothing else:
 * it is deliberately not a `kn-next.config.ts` key and not a CLI flag.
 *
 * This module IS bundled into the published `@getknext/core` (both compile
 * scripts import it), so the variable exists in what users install. It is
 * refused unless `GITHUB_ACTIONS === "true"`: outside a GitHub Actions job a
 * set `KNEXT_BUN_BASE_EXE` throws with a "CI-only" message instead of
 * compiling against an arbitrary base. That is a guard against accidental use,
 * not a security boundary — anyone can export GITHUB_ACTIONS=true, and anyone
 * who can set environment variables for a build already controls that build.
 *
 * Fail closed. If the variable is present at all (even empty), the file it
 * names must exist, be a regular executable file, and hash to the sha256
 * recorded in the sibling `<path>.sha256` file: exactly one line, either a
 * bare hex digest or `sha256sum` format whose filename is this file's
 * basename. Anything else throws — a compile that silently fell back to the
 * stock base would report a stock-Bun result as a patched-Bun verification.
 *
 * When the variable is absent, the result is `{}`, so the compile options are
 * exactly what the script built. The compile scripts never see the value:
 * they build every `compile` through `sealCompile()`, which refuses a part
 * that carries its own `executablePath` and appends the seam LAST (#1469
 * round 13 — a mutable seam binding and an unchecked shared compile object
 * each let an unverified base reach users' builds).
 *
 * Symlinks are NOT confined: the path is followed wherever it points, and the
 * sha256 check is what binds the bytes. Point it only at a downloaded,
 * signature-verified artifact directory.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * Primordials (#1469 round 14): every intrinsic this module calls, captured ONCE at evaluation.
 * `sealCompile()` decides with these and nothing looked up at call time, so a later
 * `WeakSet.prototype.has = () => true`, `Object.hasOwn = () => false` or `Object.freeze = (o) => o`
 * (in any module, however spelled) cannot change its answer. They are pristine because both
 * compile scripts import this module FIRST (before any other relative module) and it imports only
 * `node:` builtins, so no code in the compile scripts' import closure runs before these lines; the
 * seam scan asserts that order. `uncurryThis(f)(self, ...args)` is `f.call(self, ...args)` through
 * a BOUND `call`, so a later patch of `Function.prototype.call` or `.bind` does not reach it either.
 */
const uncurryThis = Function.prototype.bind.bind(Function.prototype.call);
const WeakSetHas = uncurryThis(WeakSet.prototype.has);
const WeakSetAdd = uncurryThis(WeakSet.prototype.add);
const { assign: ObjectAssign, create: ObjectCreate, freeze: ObjectFreeze, hasOwn: ObjectHasOwn, keys: ObjectKeys } = Object;

export const BUN_BASE_EXE_ENV = "KNEXT_BUN_BASE_EXE";

export class BunBaseExeError extends Error {
    constructor(message) {
        super(`${BUN_BASE_EXE_ENV}: ${message}`);
        this.name = "BunBaseExeError";
    }
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ executablePath?: string }} spread into Bun.build's `compile`
 */
export function bunBaseExeCompileOptions(env = process.env) {
    if (!ObjectHasOwn(env, BUN_BASE_EXE_ENV)) return {};
    if (env.GITHUB_ACTIONS !== "true") {
        throw new BunBaseExeError(
            "is CI-only (a patched Bun base for verifying upstream fixes) and is refused outside GitHub Actions — unset it",
        );
    }
    const raw = env[BUN_BASE_EXE_ENV];
    if (typeof raw !== "string" || raw.trim() === "") {
        throw new BunBaseExeError("is set but empty — unset it to compile with the stock Bun base");
    }
    const exe = resolve(raw.trim());
    if (!existsSync(exe)) throw new BunBaseExeError(`${exe} does not exist`);
    if (!statSync(exe).isFile()) throw new BunBaseExeError(`${exe} is not a regular file`);
    try {
        accessSync(exe, constants.X_OK);
    } catch {
        throw new BunBaseExeError(`${exe} is not executable`);
    }
    const sumFile = `${exe}.sha256`;
    if (!existsSync(sumFile)) {
        throw new BunBaseExeError(`${sumFile} is missing — the base executable must ship with its sha256`);
    }
    const lines = readFileSync(sumFile, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "");
    if (lines.length !== 1) {
        throw new BunBaseExeError(`${sumFile} must hold exactly one line, found ${lines.length}`);
    }
    const m = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(lines[0].trim());
    if (!m) {
        throw new BunBaseExeError(`${sumFile} does not start with a sha256 hex digest`);
    }
    const expected = m[1].toLowerCase();
    if (m[2] !== undefined && basename(m[2]) !== basename(exe)) {
        throw new BunBaseExeError(`${sumFile} names ${m[2]}, not ${basename(exe)}`);
    }
    const actual = createHash("sha256").update(readFileSync(exe)).digest("hex");
    if (actual !== expected) {
        throw new BunBaseExeError(`sha256 mismatch for ${exe}: expected ${expected}, got ${actual}`);
    }
    return { executablePath: exe };
}

/** The key the seam owns. Spelled once, here, so the seam scan can ban it everywhere else. */
const SEAM_KEY = "executablePath";

/**
 * Resolve the seam ONCE, at import, from `process.env`. A bad value is not thrown here: it is kept
 * and thrown by `assertBunBaseExe()` (the scripts' early, prefixed exit) and by `sealCompile()`
 * (so a script that skipped the assert still fails closed rather than compiling on stock Bun).
 */
function loadBunBaseExe() {
    try {
        return [bunBaseExeCompileOptions(), undefined];
    } catch (err) {
        return [{}, err];
    }
}
const [RESOLVED_BUN_BASE_EXE, BUN_BASE_EXE_ERROR] = loadBunBaseExe();

/**
 * The seam's value, frozen and module-private: `{}` or `{ executablePath }`. Read ONLY by
 * `sealCompile()` (the seam scan counts its references), so no compile script can rebind it,
 * `Object.assign` into it, or spread it anywhere a check does not see (#1469 round 13).
 */
const BUN_BASE_EXE = ObjectFreeze({ ...RESOLVED_BUN_BASE_EXE });

/** Throws the seam's resolution error, if any. The compile scripts call it first, before any work. */
export function assertBunBaseExe() {
    if (BUN_BASE_EXE_ERROR !== undefined) throw BUN_BASE_EXE_ERROR;
}

/** Compile objects this module produced — the only parts allowed to carry the seam's key. */
const SEALED = new WeakSet();

/**
 * The ONLY way a compile script builds a `Bun.build` `compile` value (the seam scan asserts every
 * `compile:` is a `sealCompile(...)` call). Merges `parts` in order and appends the seam LAST, into
 * a fresh, frozen, null-prototype object — so nothing inherited, nothing written afterwards and
 * nothing spread after the seam can supply a different base executable.
 *
 * Throws if any part carries `executablePath` by any route — own or inherited, enumerable or not,
 * however the key was spelled in source (a computed `"executable" + "Path"` is the same string at
 * runtime). Each part is copied once and the COPY is both checked and merged, so a Proxy cannot
 * answer the check one way and the merge another. The one exemption is a value this function
 * returned earlier (a sealed compile re-sealed with more fields): its key can only be the seam's.
 *
 * Every intrinsic it calls is a primordial captured at evaluation (above), and it walks arrays by
 * index, never through an iterator: the seam scan reds a method call or a global name in its body.
 *
 * @param {...(Record<string, unknown> | undefined)} parts
 * @returns {Readonly<Record<string, unknown>>}
 */
export function sealCompile(...parts) {
    assertBunBaseExe();
    const out = ObjectCreate(null);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === undefined) continue;
        if (part === null || typeof part !== "object") {
            throw new BunBaseExeError(`sealCompile: a compile part must be an object, got ${part === null ? "null" : typeof part}`);
        }
        const copy = { ...part };
        if (!WeakSetHas(SEALED, part)) {
            let foreign = SEAM_KEY in part;
            const keys = ObjectKeys(copy);
            for (let j = 0; j < keys.length; j++) if (keys[j] === SEAM_KEY) foreign = true;
            for (const k in part) if (k === SEAM_KEY) foreign = true;
            if (foreign) {
                throw new BunBaseExeError(
                    `sealCompile: a compile part carries ${SEAM_KEY} — only the seam, appended by sealCompile, may choose the base executable`,
                );
            }
        }
        ObjectAssign(out, copy);
    }
    ObjectAssign(out, BUN_BASE_EXE);
    // A re-sealed part may carry the key only as the seam put it; the seam, last, overwrote it.
    if (ObjectHasOwn(out, SEAM_KEY) && out[SEAM_KEY] !== BUN_BASE_EXE[SEAM_KEY]) {
        throw new BunBaseExeError(`sealCompile: ${SEAM_KEY} does not match the seam`);
    }
    const sealed = ObjectFreeze(out);
    WeakSetAdd(SEALED, sealed);
    return sealed;
}

/**
 * The ONLY way a compile script builds the options object `Bun.build` receives (#1469 round 15 —
 * round 14 sealed the `compile` VALUE but nothing checked, at the `Bun.build` call, that the
 * options still carried that exact value: a helper that overwrote `opts.compile` after sealing, or
 * a spread placed after the `compile:` key, reached `Bun.build` with an unverified base executable
 * while every scan on the `compile` value alone stayed green).
 *
 * Shallow-copies `opts` into a fresh, null-prototype object and throws unless `copy.compile` is an
 * object `sealCompile()` itself returned — checked by `SEALED` WeakSet membership, through the same
 * captured, bound `has` primordial `sealCompile` uses, so a later patch of `WeakSet.prototype.has`
 * cannot change the answer. `sealCompile` freezes every value it returns, so nothing can rewrite a
 * sealed compile object in place; the only way to make `copy.compile` diverge from what `sealCompile`
 * produced is to replace the reference, which is exactly what this refuses.
 *
 * The seam scan requires the two compile scripts' single `Bun.build` argument to be a direct
 * `sealBuild(...)` call, so whatever object a compile script builds — however a helper mutated it —
 * is checked here, at the one call Bun reads.
 *
 * @param {Record<string, unknown>} opts
 * @returns {Readonly<Record<string, unknown>>}
 */
export function sealBuild(opts) {
    const copy = { ...opts };
    const out = ObjectCreate(null);
    ObjectAssign(out, copy);
    if (!WeakSetHas(SEALED, out.compile)) {
        throw new BunBaseExeError(
            "sealBuild: opts.compile must be the exact object sealCompile(...) returned — Bun.build's argument must be built only through sealBuild(...)",
        );
    }
    return ObjectFreeze(out);
}
