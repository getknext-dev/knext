/**
 * The manifest scanner (ADR-0069 D5): a pure byte scan of the library file for
 * `KNEXTFFI1<json>\0` records. It never loads the library, so a musl `.so`
 * built on a macOS host scans the same as the host's own `.dylib`.
 */

import { describe, expect, it } from 'bun:test';
import { fnv1a64, MAGIC, manifestDigest, scanManifest, schemaString, typeToken } from '../manifest';
import { blob, D, enumRecord, fn, KITCHEN_SINK, record } from './helpers';

const greet = fn('greet', [['name', D.t('string')]], D.t('string'));

describe('scanManifest — record counts', () => {
  it('the magic is the 9 bytes KNEXTFFI1', () => {
    expect(MAGIC).toBe('KNEXTFFI1');
  });

  it('zero records: refuses, asking whether this is the right library', () => {
    expect(() => scanManifest(blob([]))).toThrow(
      'no exported functions found; is this the right library?',
    );
  });

  it('records but no functions is still "no exported functions"', () => {
    expect(() => scanManifest(blob([enumRecord('Color', ['Red'])]))).toThrow(
      'no exported functions found',
    );
  });

  it('one record', () => {
    const m = scanManifest(blob([greet]));
    expect(m.fns.map((f) => f.name)).toEqual(['greet']);
    expect(m.fns[0]?.symbol).toBe('knext_ffi_v1_greet_0badc0de');
    expect(m.records).toEqual([]);
    expect(m.enums).toEqual([]);
  });

  it('many records, sorted by name whatever their order in the file', () => {
    const m = scanManifest(blob([...KITCHEN_SINK].reverse()));
    expect(m.fns.map((f) => f.name)).toEqual([...m.fns.map((f) => f.name)].sort());
    expect(m.fns).toHaveLength(18);
    expect(m.records.map((r) => r.name)).toEqual(['Inner', 'Point']);
    expect(m.enums.map((e) => e.name)).toEqual(['Color']);
  });

  it('an identical record twice (a universal binary carries two slices) is read once', () => {
    expect(scanManifest(blob([greet, greet])).fns).toHaveLength(1);
  });

  it('the manifest digest ignores record order and file layout', () => {
    const a = scanManifest(blob(KITCHEN_SINK));
    const b = scanManifest(blob([...KITCHEN_SINK].reverse(), '\u0000\u0000junk'));
    expect(manifestDigest(a)).toBe(manifestDigest(b));
    expect(manifestDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    const c = scanManifest(blob([fn('greet', [['who', D.t('string')]], D.t('string'))]));
    expect(manifestDigest(c)).not.toBe(manifestDigest(scanManifest(blob([greet]))));
  });
});

describe('scanManifest — refusals (each names what is wrong)', () => {
  it('a truncated record (no NUL before end of file)', () => {
    const bytes = new TextEncoder().encode(`xxKNEXTFFI1${JSON.stringify(greet)}`);
    expect(() => scanManifest(bytes)).toThrow(/truncated manifest record at byte 2/);
  });

  it('a record cut short inside its JSON', () => {
    const json = JSON.stringify(greet);
    const bytes = new TextEncoder().encode(`KNEXTFFI1${json.slice(0, 20)}\u0000`);
    expect(() => scanManifest(bytes)).toThrow(/manifest record at byte 0 is not valid JSON/);
  });

  it('a false-positive magic in user data names the byte offset', () => {
    const bytes = new TextEncoder().encode(
      `KNEXTFFI1${JSON.stringify(greet)}\u0000padKNEXTFFI1 hello\u0000`,
    );
    const at = new TextDecoder().decode(bytes).lastIndexOf('KNEXTFFI1');
    expect(() => scanManifest(bytes)).toThrow(`manifest record at byte ${at} is not valid JSON`);
  });

  it('an unknown ABI/manifest version is refused', () => {
    expect(() => scanManifest(blob([{ ...greet, v: 2 }]))).toThrow(
      /unsupported manifest version 2 at byte \d+; this @getknext\/ffi reads version 1/,
    );
  });

  it('a duplicate export name', () => {
    const other = fn('greet', [['who', D.t('string')]], D.t('string'), { hash: '11111111' });
    expect(() => scanManifest(blob([greet, other]))).toThrow(
      'duplicate export "greet": two different functions in one library have the same name',
    );
  });

  it('a duplicate record or enum name', () => {
    expect(() =>
      scanManifest(blob([greet, enumRecord('Color', ['Red']), record('Color', [])])),
    ).toThrow('duplicate type "Color"');
  });

  it('a function naming a record with no record of its own', () => {
    const f = fn('mid', [['p', D.rec('Point')]], D.t('unit'));
    expect(() => scanManifest(blob([f]))).toThrow(
      'mid: argument "p" names record "Point", but the library has no record for it',
    );
  });

  it('a record field naming a missing enum', () => {
    expect(() => scanManifest(blob([greet, record('Point', [['c', D.en('Color')]])]))).toThrow(
      'Point: field "c" names enum "Color", but the library has no enum for it',
    );
  });

  it('a record named where the library has an enum of that name', () => {
    const f = fn('paint', [['c', D.rec('Color')]], D.t('unit'));
    expect(() => scanManifest(blob([f, enumRecord('Color', ['Red'])]))).toThrow(
      'paint: argument "c" names record "Color", but "Color" is an enum',
    );
  });

  it('a symbol that is not knext_ffi_v1_<name>_<8 hex>', () => {
    for (const symbol of [
      'greet',
      'knext_ffi_v1_greet',
      'knext_ffi_v1_other_0badc0de',
      'knext_ffi_v1_greet_0BADC0DE',
    ]) {
      expect(() => scanManifest(blob([{ ...greet, symbol }])), symbol).toThrow(
        /greet: symbol .* is not knext_ffi_v1_greet_<8 hex digits>/,
      );
    }
  });

  it('an unknown type', () => {
    const f = fn('f', [['x', D.t('i128')]], D.t('unit'));
    expect(() => scanManifest(blob([f]))).toThrow('f: argument "x" has unknown type "i128"');
  });

  it('unit anywhere but a return', () => {
    const f = fn('f', [['x', D.t('unit')]], D.t('unit'));
    expect(() => scanManifest(blob([f]))).toThrow('f: argument "x" cannot be unit');
    expect(() => scanManifest(blob([greet, record('R', [['u', D.opt(D.t('unit'))]])]))).toThrow(
      'R: field "u" cannot be unit',
    );
  });

  it('a name that is not a valid identifier, or a reserved word', () => {
    expect(() => scanManifest(blob([fn('new', [], D.t('unit'))]))).toThrow(
      '"new" cannot be a generated function name',
    );
    expect(() => scanManifest(blob([fn('f', [['delete', D.t('i32')]], D.t('unit'))]))).toThrow(
      '"delete" cannot be a generated argument name',
    );
    expect(() => scanManifest(blob([greet, record('RustError', [])]))).toThrow(
      '"RustError" cannot be a generated type name',
    );
  });

  it('a record whose shape is wrong (missing fields array)', () => {
    expect(() => scanManifest(blob([greet, { v: 1, kind: 'record', name: 'P', doc: '' }]))).toThrow(
      /manifest record at byte \d+ \(record "P"\) is malformed/,
    );
  });
});

describe('the transitive schema hash (ADR-0069 D4, round 2) — goldens shared with the knext-ffi crate', () => {
  // The same three pairs are pinned by the crate's own test
  // (crates/knext-ffi-fixture/tests/abi.rs, schema_values_are_golden), so the
  // Rust const fn and this hash cannot disagree on the same string.
  it.each([
    ['add(i32,i32)->i32', '29df491fa1e52ca6'],
    ['next_color(Color)->ColorColor[Red|Green|Blue]', 'a34dde499fdb102f'],
    [
      'mid(Point,Point)->PointChild{name:string,flag:bool}Color[Red|Green|Blue]Point{id:u64,delta:i64,size:usize,offset:isize,x:f64,y:f32,small:u8,label:string,tags:vec<string>,maybe:option<i64>,color:Color,raw:vec<u8>,child:option<Child>,ids:vec<u64>}',
      '0865ccb5df46187d',
    ],
  ])('fnv1a64(%s)', (s, hex) => {
    expect(fnv1a64(s).toString(16).padStart(16, '0')).toBe(hex);
  });

  it('the schema string is sig + every reachable record/enum, transitive, deduped, sorted together by name', () => {
    const t = D.t;
    const point = record('Point', [
      ['id', t('u64')],
      ['delta', t('i64')],
      ['size', t('usize')],
      ['offset', t('isize')],
      ['x', t('f64')],
      ['y', t('f32')],
      ['small', t('u8')],
      ['label', t('string')],
      ['tags', D.vec(t('string'))],
      ['maybe', D.opt(t('i64'))],
      ['color', D.en('Color')],
      ['raw', D.vec(t('u8'))],
      ['child', D.opt(D.rec('Child'))],
      ['ids', D.vec(t('u64'))],
    ]);
    const child = record('Child', [
      ['name', t('string')],
      ['flag', t('bool')],
    ]);
    const color = enumRecord('Color', ['Red', 'Green', 'Blue']);
    const mid = fn(
      'mid',
      [
        ['a', D.rec('Point')],
        ['b', D.rec('Point')],
      ],
      D.rec('Point'),
    );
    const m = scanManifest(blob([mid, point, child, color]));
    const f = m.fns[0];
    if (!f) throw new Error('no fn');
    expect(f.sig).toBe('mid(Point,Point)->Point');
    expect(schemaString(f, m)).toBe(
      'mid(Point,Point)->PointChild{name:string,flag:bool}Color[Red|Green|Blue]Point{id:u64,delta:i64,size:usize,offset:isize,x:f64,y:f32,small:u8,label:string,tags:vec<string>,maybe:option<i64>,color:Color,raw:vec<u8>,child:option<Child>,ids:vec<u64>}',
    );
    expect(fnv1a64(schemaString(f, m)).toString(16).padStart(16, '0')).toBe('0865ccb5df46187d');
  });

  it('a function that names no record hashes its sig alone; unreachable records are left out', () => {
    const add = fn(
      'add',
      [
        ['a', D.t('i32')],
        ['b', D.t('i32')],
      ],
      D.t('i32'),
    );
    const m = scanManifest(blob([add, record('Unused', [])]));
    const f = m.fns[0];
    if (!f) throw new Error('no fn');
    expect(schemaString(f, m)).toBe('add(i32,i32)->i32');
  });

  it('typeToken: option<…>/vec<…> lowercase, records and enums by bare name', () => {
    expect(typeToken({ t: 'vec', of: { t: 'option', of: { t: 'record', name: 'P' } } })).toBe(
      'vec<option<P>>',
    );
  });
});
