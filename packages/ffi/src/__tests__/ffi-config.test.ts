/**
 * `knext.ffi.json` v1 (ADR-0069 D11): validation mirrors `knext.grpc.json`'s
 * `out` rules, unknown keys are rejected, and the file is the only opt-in.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  FfiUsageError,
  loadConfig,
  parseConfig,
  serializeConfig,
} from '../config';
import { emptyDir, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

describe('knext.ffi.json v1', () => {
  it('is named knext.ffi.json and defaults to rust/ and src/generated/ffi', () => {
    expect(CONFIG_FILE).toBe('knext.ffi.json');
    expect(DEFAULT_CONFIG).toEqual({ version: 1, crate: 'rust', out: 'src/generated/ffi' });
  });

  it('accepts the documented shape and normalises trailing slashes', () => {
    expect(parseConfig({ version: 1, crate: 'native/rust/', out: 'lib/ffi/' })).toEqual({
      version: 1,
      crate: 'native/rust',
      out: 'lib/ffi',
    });
  });

  it('fills defaults for crate and out', () => {
    expect(parseConfig({ version: 1 })).toEqual(DEFAULT_CONFIG);
  });

  it('requires version 1', () => {
    for (const raw of [{}, { version: 2 }, { version: '1' }]) {
      expect(() => parseConfig(raw)).toThrow(FfiUsageError);
    }
    expect(() => parseConfig({ version: 2 })).toThrow(/"version" must be 1/);
  });

  it('rejects unknown keys, naming them', () => {
    expect(() => parseConfig({ version: 1, targets: ['x86_64-unknown-linux-musl'] })).toThrow(
      'knext.ffi.json: unknown setting "targets"',
    );
  });

  it('rejects anything but an object', () => {
    for (const raw of [null, [], 'x', 1]) expect(() => parseConfig(raw)).toThrow(FfiUsageError);
  });

  for (const key of ['crate', 'out'] as const) {
    it(`"${key}" must be a subdirectory of the app, outside node_modules`, () => {
      for (const bad of [
        '',
        ' ',
        '.',
        './',
        'src/..',
        '..',
        '../x',
        '/abs',
        'a\\b',
        'node_modules/x',
        'x/NODE_MODULES',
        1,
      ]) {
        expect(() => parseConfig({ version: 1, [key]: bad }), JSON.stringify(bad)).toThrow(
          `"${key}" must be a subdirectory of the app, outside node_modules`,
        );
      }
    });
  }

  it('serialises with a fixed key order and a trailing newline', () => {
    expect(serializeConfig({ version: 1, crate: 'rust', out: 'src/generated/ffi' })).toBe(
      '{\n  "version": 1,\n  "crate": "rust",\n  "out": "src/generated/ffi"\n}\n',
    );
  });

  it('loadConfig: a missing file says to run knext ffi init', () => {
    const dir = emptyDir('cfg-missing');
    expect(() => loadConfig(dir)).toThrow(/no knext\.ffi\.json in .*Run `knext ffi init`/);
  });

  it('loadConfig: invalid JSON is a usage error, not a crash', () => {
    const dir = emptyDir('cfg-bad-json');
    writeFileSync(join(dir, CONFIG_FILE), '{ nope');
    expect(() => loadConfig(dir)).toThrow(/knext\.ffi\.json is not valid JSON/);
  });

  it('loadConfig: reads and validates the file', () => {
    const dir = emptyDir('cfg-ok');
    writeFileSync(join(dir, CONFIG_FILE), '{"version":1,"crate":"r","out":"gen"}');
    expect(loadConfig(dir)).toEqual({ version: 1, crate: 'r', out: 'gen' });
  });
});
