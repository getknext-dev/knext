/**
 * A fake, pinned Rust supply-chain toolchain on disk, for tests that must not
 * need Rust, zig or the network: a `$CARGO_HOME/bin` holding the four cargo
 * subcommands (empty executables) plus the `.crates2.json` record `cargo
 * install` writes beside it, and a `zig` on a PATH directory. `answer` replies
 * to the version probes the way the real pinned releases do (measured:
 * cargo-zigbuild 0.23.4, cargo-deny 0.20.2, cargo-cyclonedx 0.5.9, zig 0.17.0;
 * cargo-auditable 0.7.7 has no version flag at all).
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RunResult } from '../build';
import { CARGO_TOOL_PINS, ZIG_PIN } from '../supply-chain';
import { emptyDir, PKG_DIR } from './helpers';

export type ToolCrate = 'cargo-zigbuild' | 'cargo-deny' | 'cargo-auditable' | 'cargo-cyclonedx';

export const PINNED: Record<ToolCrate, string> = {
  'cargo-zigbuild': CARGO_TOOL_PINS.zigbuild.version,
  'cargo-deny': CARGO_TOOL_PINS.deny.version,
  'cargo-auditable': CARGO_TOOL_PINS.auditable.version,
  'cargo-cyclonedx': CARGO_TOOL_PINS.cyclonedx.version,
};

export interface FakeToolchainOptions {
  /** Installed version per tool; `null` means not installed. Default: the pin. */
  readonly versions?: Partial<Record<ToolCrate, string | null>>;
  /** The `zig` on PATH: its version, or `null` for none. Default: the pin. */
  readonly zig?: string | null;
  /** Write no `.crates2.json` (a cargo-auditable that was not installed by `cargo install`). */
  readonly noInstallRecord?: boolean;
}

export interface FakeToolchain {
  readonly env: NodeJS.ProcessEnv;
  readonly cargoHome: string;
  readonly zigBin: string | undefined;
  /** The fake reply to a version probe, or undefined when `cmd` is not one. */
  answer(cmd: string, args: readonly string[]): RunResult | undefined;
}

const exe = (p: string) => {
  writeFileSync(p, '#!/bin/sh\nexit 99\n');
  chmodSync(p, 0o755);
};

export function fakeToolchain(opts: FakeToolchainOptions = {}): FakeToolchain {
  const cargoHome = emptyDir('cargo-home');
  mkdirSync(join(cargoHome, 'bin'));
  const versions = { ...PINNED, ...opts.versions };
  const installs: Record<string, unknown> = {};
  for (const [crate, v] of Object.entries(versions) as [ToolCrate, string | null][]) {
    if (v === null) continue;
    exe(join(cargoHome, 'bin', crate));
    installs[`${crate} ${v} (registry+https://github.com/rust-lang/crates.io-index)`] = {
      version_req: `=${v}`,
      bins: [crate],
      features: [],
      all_features: false,
      no_default_features: false,
      profile: 'release',
      target: 'aarch64-apple-darwin',
      rustc: 'rustc 1.97.1 (f2cbd5adb 2026-08-04)\nbinary: rustc\n',
    };
  }
  if (!opts.noInstallRecord) {
    writeFileSync(join(cargoHome, '.crates2.json'), JSON.stringify({ installs }));
  }

  const zigVersion = opts.zig === undefined ? ZIG_PIN.version : opts.zig;
  let zigBin: string | undefined;
  const pathDirs: string[] = [];
  if (zigVersion !== null) {
    const dir = emptyDir('zig-on-path');
    zigBin = join(dir, 'zig');
    exe(zigBin);
    pathDirs.push(dir);
  }

  const ok = (stdout: string): RunResult => ({ status: 0, stdout });
  return {
    env: { PATH: pathDirs.join(':'), CARGO_HOME: cargoHome, HOME: emptyDir('home') },
    cargoHome,
    zigBin,
    answer(cmd, args) {
      const name = basename(cmd);
      const key = args.join(' ');
      if (name === 'cargo-zigbuild' && key === '--version') {
        return ok(`cargo-zigbuild ${versions['cargo-zigbuild']}\n`);
      }
      if (name === 'cargo-deny' && key === '--version') {
        return ok(`cargo-deny ${versions['cargo-deny']}\n`);
      }
      if (name === 'cargo-cyclonedx' && key === 'cyclonedx --version') {
        return ok(`cargo-cyclonedx-cyclonedx ${versions['cargo-cyclonedx']}\n`);
      }
      if (name === 'cargo-auditable') {
        // The real 0.7.7: no version flag; refuses to run outside cargo.
        return { status: 1, stdout: '' };
      }
      if (cmd === zigBin && key === 'version') return ok(`${zigVersion}\n`);
      return undefined;
    },
  };
}

/** Real tool output and real-tool-derived libraries (fixtures/supply-chain/README.md). */
export const SUPPLY_FIXTURES = join(PKG_DIR, 'fixtures', 'supply-chain');
export const supplyFixture = (name: string): Buffer => readFileSync(join(SUPPLY_FIXTURES, name));
