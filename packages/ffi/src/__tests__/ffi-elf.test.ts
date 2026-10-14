/**
 * The libc check (ADR-0069 D14 step 3), against real libraries built by a
 * real linker (fixtures/elf, see its README): a musl library is accepted, a
 * glibc one is refused by name, and the architecture must match the target.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowedNeeded, assertMuslLibrary, ElfError, readElf } from '../elf';
import { PKG_DIR } from './helpers';

const fixture = (name: string) => readFileSync(join(PKG_DIR, 'fixtures', 'elf', name));
const X64 = 'x86_64-unknown-linux-musl';
const ARM64 = 'aarch64-unknown-linux-musl';

describe('readElf', () => {
  it('reads the machine and DT_NEEDED of a real musl x86_64 library', () => {
    expect(readElf(fixture('libmusl_x64.so'))).toEqual({
      arch: 'x86_64',
      needed: ['libc.musl-x86_64.so.1'],
    });
  });

  it('reads a real musl aarch64 library', () => {
    expect(readElf(fixture('libmusl_arm64.so'))).toEqual({
      arch: 'aarch64',
      needed: ['libc.musl-aarch64.so.1'],
    });
  });

  it('reads a real glibc library', () => {
    expect(readElf(fixture('libglibc_x64.so')).needed).toEqual(['libc.so.6']);
  });

  it('refuses a non-ELF file, a Mach-O-like blob and a truncated header', () => {
    expect(() => readElf(new TextEncoder().encode('hello world'))).toThrow(ElfError);
    expect(() =>
      readElf(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, ...new Array(80).fill(0)])),
    ).toThrow('not an ELF file');
    expect(() => readElf(fixture('libmusl_x64.so').subarray(0, 40))).toThrow('truncated');
  });

  it('refuses a 32-bit ELF', () => {
    const b = new Uint8Array(fixture('libmusl_x64.so'));
    b[4] = 1;
    expect(() => readElf(b)).toThrow('64-bit little-endian');
  });
});

describe('assertMuslLibrary', () => {
  it('accepts a musl library for its own architecture', () => {
    expect(assertMuslLibrary(fixture('libmusl_x64.so'), X64, 'libzone.so')).toEqual([
      'libc.musl-x86_64.so.1',
    ]);
    expect(assertMuslLibrary(fixture('libmusl_arm64.so'), ARM64, 'libzone.so')).toEqual([
      'libc.musl-aarch64.so.1',
    ]);
  });

  it('refuses a glibc library, naming libc.so.6', () => {
    expect(() => assertMuslLibrary(fixture('libglibc_x64.so'), X64, 'libzone.so')).toThrow(
      /libzone\.so links libc\.so\.6, which the musl \(Alpine\) image does not have/,
    );
  });

  it('refuses a library built for the other architecture', () => {
    expect(() => assertMuslLibrary(fixture('libmusl_arm64.so'), X64, 'libzone.so')).toThrow(
      'built for aarch64, but the target x86_64-unknown-linux-musl is x86_64',
    );
  });

  it('allows exactly libc.so, the two musl sonames and libgcc_s', () => {
    expect([...allowedNeeded('x86_64')].sort()).toEqual([
      'ld-musl-x86_64.so.1',
      'libc.musl-x86_64.so.1',
      'libc.so',
      'libgcc_s.so.1',
    ]);
    // glibc's names are never on it, for either architecture.
    for (const arch of ['x86_64', 'aarch64']) {
      const allowed = allowedNeeded(arch);
      expect(allowed.has('libc.so.6')).toBe(false);
      expect(allowed.has(`ld-linux-${arch}.so.2`)).toBe(false);
    }
  });
});
