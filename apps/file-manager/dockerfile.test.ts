/**
 * ADR-0048 — file-manager's vinext single-executable image.
 *
 * Structural, not a build. `docker build` needs registry credentials from a
 * keychain that is locked in this environment, so the image itself is
 * unverified here and must be built in CI before it replaces the node one.
 * What IS checkable is the contract: the ordering that bit us, the target
 * triple that must match the runtime libc, and the absence of the machinery
 * ADR-0048 retires.
 *
 * A `toContain` check passes on a Dockerfile that cannot build. These assert
 * relationships — order, matching pairs, mutual exclusion — rather than
 * substrings in isolation.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DF = readFileSync(join(import.meta.dirname, 'Dockerfile'), 'utf8');
const lineOf = (needle: string): number => DF.split('\n').findIndex((l) => l.includes(needle));

describe('#ADR-0048 file-manager vinext image — build order', () => {
  it('builds @getknext/lib BEFORE the app', () => {
    // Not cosmetic. The app imports the library's built `dist`, so building
    // the app first compiles against the PREVIOUS library. That cost real
    // time here: the app built cleanly and the stale code only surfaced at
    // runtime, as a missing module inside the binary.
    const lib = lineOf('--filter "@getknext/lib" build');
    const app = lineOf('vite build');

    expect(lib).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(-1);
    expect(lib).toBeLessThan(app);
  });

  it('verifies the nitro entry EXISTS before compiling it', () => {
    // The #857 shape: a build that exits 0 while emitting no server. The
    // check has to sit between the build and the compile, or the image
    // ships a CMD pointing at nothing.
    const build = lineOf('vite build');
    const check = lineOf('.output/server/index.mjs \\');
    // The compile moved from a bare `bun build --compile` into
    // `scripts/compile-single-exec.mjs`, because it now needs BUILD PLUGINS and
    // the CLI has no `--plugin`: one rewrites `import.meta` so `--bytecode` can
    // compile the bundle, the other swaps sharp's addon loader for a dlopen
    // shim. The ordering this guards is unchanged.
    const compile = lineOf('vinext-compile.js');

    expect(build).toBeLessThan(check);
    expect(check).toBeLessThan(compile);
  });

  it('compiles WITH bytecode, through the script that can', () => {
    // `--bytecode` is not reachable from the CLI here: it emits CommonJS, where
    // the nitro bundle's `import.meta` is a syntax error, so the build fails
    // with `Failed to generate bytecode`. The script rewrites those first.
    // Asserted on the SCRIPT, not the Dockerfile, because that is where the
    // flag lives now.
    // Reads the SHARED script the CLI ships, not an app-local copy: this app
    // deliberately builds the same way a user's `kn-next build` does, so a
    // private copy here would let the two drift and hide a user-facing break.
    const script = readFileSync(
      join(import.meta.dirname, '../../packages/kn-next/src/adapters/vinext-compile.mjs'),
      'utf8',
    );
    expect(script, 'the single-exec build must enable bytecode').toMatch(/bytecode:\s*true/);
    expect(script, 'the sharp addon shim must be wired into the compile').toContain(
      'sharp-addon-dlopen',
    );
  });

  it('ships the sharp native tree into the runtime layer', () => {
    // Without it `/_next/image` serves unoptimized originals: a compiled binary
    // cannot resolve a package from disk, so the addon has to be a real file
    // beside the executable, with its layout intact (relative rpath to libvips).
    // Two halves, because the path lives in a variable: the tree is SOURCED
    // from @img, and it is copied with -RL (dereferencing bun's symlinked
    // isolated store — a plain -R would leave dangling links in the image).
    expect(DF, 'the builder must source the @img tree').toMatch(/SRC=[^\n]*@img/);
    expect(DF, 'and copy it dereferenced').toMatch(/cp -RL[^\n]*\$SRC/);
    // NOT per-platform. Naming the directory means encoding sharp's own scheme,
    // and that guess was wrong once: sharp uses `linuxmusl`, one word, so the
    // build died on `can't stat .../@img/sharp-linux-musl-x64`. Copying whatever
    // bun installed for this platform avoids the guess entirely.
    expect(DF, 'staging must not hardcode a per-platform @img directory').not.toMatch(
      /sharp-\$\{IMG_PLATFORM\}/,
    );
    // libvips ships a `stub.node` that also matches `sharp-*`; picking it would
    // dlopen the wrong library.
    expect(DF, 'addon selection must exclude libvips').toMatch(/-not -path[^\n]*libvips/);
    expect(DF, 'the runtime layer must receive the tree').toMatch(
      /COPY --from=builder \/repo\/native \/app\/native/,
    );
  });

  it('pins the staged native tree before the runtime layer copies it', () => {
    // C2: this Dockerfile stages @img ITSELF rather than calling
    // `stageSharpNative`, so the CLI's pinning does not reach it. Ordering is
    // the whole assertion — a manifest written after the COPY would ship a
    // record of a tree the image never received.
    const staged = lineOf('cp -RL');
    const pinned = lineOf('write-native-integrity.mjs');
    const copied = lineOf('COPY --from=builder /repo/native');
    expect(pinned, 'the native tree must be pinned by the shared writer').toBeGreaterThan(-1);
    expect(pinned).toBeGreaterThan(staged);
    expect(pinned).toBeLessThan(copied);
    // The lockfile is the provenance half; hashing a tree without checking what
    // it claims to be would record whatever was there.
    expect(DF, 'pinning must read the lockfile').toMatch(
      /write-native-integrity\.mjs [^\n]*bun\.lock/,
    );
  });

  it('compiles for musl, matching the alpine runtime stage', () => {
    // A glibc binary exits on alpine with no useful message. The target and
    // the base image are a matched pair; asserting one without the other
    // would let them drift.
    expect(DF).toMatch(/BUN_TARGET=bun-linux-\w+-musl/);
    expect(DF).toMatch(/FROM alpine:/);
  });
});

describe('#ADR-0048 file-manager vinext image — what it must NOT carry', () => {
  /** Only the runtime stage: the builder legitimately uses node and pnpm. */
  const runtimeStage = DF.slice(DF.lastIndexOf('FROM alpine:'));

  it('ships no bytecode cache — it is baked into the binary', () => {
    // The point of the goal: `bun build --bytecode` puts V8 bytecode inside
    // the executable, so there is nothing to warm, mount or share.
    expect(runtimeStage).not.toMatch(/NODE_COMPILE_CACHE/);
    expect(runtimeStage).not.toMatch(/warm-compile-cache/);
    expect(runtimeStage).not.toMatch(/compile-cache/);
    expect(runtimeStage).not.toMatch(/VOLUME/);
  });

  it('ships no node, npm, pnpm or node_modules in the runtime stage', () => {
    expect(runtimeStage).not.toMatch(/\bnpm\b/);
    expect(runtimeStage).not.toMatch(/\bpnpm\b/);
    expect(runtimeStage).not.toMatch(/node_modules/);
    expect(runtimeStage).not.toMatch(/FROM node:/);
  });

  it('ships no standalone tree', () => {
    expect(runtimeStage).not.toMatch(/\.next\/standalone/);
  });

  it('never bare-execs a foreign server — the knext entry owns SIGTERM drain and metrics', () => {
    // Carried over from the retired dockerfile-runtime-entrypoint guard. Its
    // assertions named the node/standalone entry, which is gone, but the
    // INVARIANT is not: whatever the build target, the container process must
    // be knext's own entry. Bare-execing the framework's server skips the drain
    // handler and the :9464 metrics listener, and the pod looks healthy right
    // up until a scale-down drops in-flight requests.
    expect(runtimeStage).not.toMatch(/exec\s+node\s/);
    expect(runtimeStage).not.toMatch(/server\.js/);
    expect(runtimeStage).not.toMatch(/next\s+start/);
  });

  it('runs the binary directly, as a non-root single process', () => {
    // Both halves: the binary is the entrypoint AND nothing wraps it. A
    // `sh -c` here would reintroduce a parent that owns SIGTERM, which is
    // the entry's job under this shape.
    expect(runtimeStage).toMatch(/CMD \["\/app\/server"\]/);
    expect(runtimeStage).toMatch(/USER 65532:65532/);
    expect(runtimeStage).not.toMatch(/CMD \["sh"/);
  });

  it('copies the public assets the server resolves at runtime', () => {
    // Without these beside the binary the server starts, logs "no
    // static-asset root found", and 500s every asset — it fails quietly.
    expect(runtimeStage).toMatch(/COPY --from=builder .*\.output\/public/);
  });
});
