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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DF = readFileSync(join(import.meta.dirname, 'Dockerfile.vinext'), 'utf8');
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
    const compile = lineOf('bun build --compile');

    expect(build).toBeLessThan(check);
    expect(check).toBeLessThan(compile);
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
