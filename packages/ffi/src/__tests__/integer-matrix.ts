/**
 * The integer-argument matrix, shared by the Bun suite (ffi-loader.test.ts, a C
 * library with an `echo_<width>` export per width) and the Rust crates harness
 * (crates/harness/ffi-generated.ts, the real fixture crate): the same cases
 * against both, so a width one of them forgot is caught by the other.
 *
 * It is stringified and evaluated in a fresh Bun process, so it must stay
 * self-contained: no imports, no references to anything outside its own body.
 */

/**
 * Runs in the child (it is stringified): the integer-argument matrix. Every
 * width the macros accept, each at both boundaries, one past them, a fraction,
 * NaN, +-Infinity, -0, a value whose LOW 32 BITS are in range (2^32 + 1: the
 * bun:ffi truncation), the wrong type, and the 64-bit types given a number.
 * Returns what disagreed, never throws.
 */
// biome-ignore lint/suspicious/noExplicitAny: the body runs in another process, untyped.
export function integerMatrix(
  m: any,
  c: (f: () => unknown) => any,
): { cases: number; problems: string[] } {
  const problems: string[] = [];
  let cases = 0;
  const big = (n: number | string) => BigInt(n);
  const two = (n: number) => big(2) ** big(n);
  const expectMsg = (fn: string, lo: string, hi: string) =>
    new RegExp(`^${fn}\\(\\): argument "v" must be an? (integer|bigint) from ${lo} to ${hi}, got `);
  const refuse = (fn: string, lo: string, hi: string, label: string, value: unknown) => {
    cases++;
    const r = c(() => m[fn](value));
    if (r.cls !== 'TypeError' || !expectMsg(fn, lo, hi).test(String(r.message))) {
      problems.push(
        `${fn}(${label}) was not refused: ${JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`,
      );
    }
  };
  const accept = (fn: string, label: string, value: unknown, expected: unknown) => {
    cases++;
    const r = c(() => m[fn](value));
    if (r.cls !== undefined || !Object.is(r.ok, expected)) {
      problems.push(
        `${fn}(${label}) = ${JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}, wanted ${String(expected)}`,
      );
    }
  };
  const small: [string, number, number][] = [
    ['i8', -128, 127],
    ['i16', -32768, 32767],
    ['i32', -2147483648, 2147483647],
    ['u8', 0, 255],
    ['u16', 0, 65535],
    ['u32', 0, 4294967295],
  ];
  for (const [t, lo, hi] of small) {
    const fn = `echo_${t}`;
    const L = String(lo);
    const H = String(hi);
    accept(fn, 'min', lo, lo);
    accept(fn, 'max', hi, hi);
    accept(fn, '0', 0, 0);
    accept(fn, '1', 1, 1);
    accept(fn, '-0', -0, 0);
    refuse(fn, L, H, 'min-1', lo - 1);
    refuse(fn, L, H, 'max+1', hi + 1);
    for (const [label, v] of [
      ['0.5', 0.5],
      ['-0.5', -0.5],
      ['max+0.5', hi + 0.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['2^32+1', 2 ** 32 + 1],
      ['-(2^32)-1', -(2 ** 32) - 1],
      ['2^53', 2 ** 53],
      ['MAX_VALUE', Number.MAX_VALUE],
      ['bigint 1n', big(1)],
      ['string "1"', '1'],
      ['true', true],
      ['null', null],
      ['undefined', undefined],
      ['{}', {}],
    ] as [string, unknown][]) {
      refuse(fn, L, H, label, v);
    }
  }
  const wide: [string, bigint, bigint][] = [
    ['i64', -two(63), two(63) - big(1)],
    ['u64', big(0), two(64) - big(1)],
    ['isize', -two(63), two(63) - big(1)],
    ['usize', big(0), two(64) - big(1)],
  ];
  for (const [t, lo, hi] of wide) {
    const fn = `echo_${t}`;
    const L = String(lo);
    const H = String(hi);
    accept(fn, 'min', lo, lo);
    accept(fn, 'max', hi, hi);
    accept(fn, '0n', big(0), big(0));
    accept(fn, '2^53+1', two(53) + big(1), two(53) + big(1));
    accept(fn, '2^32+1', two(32) + big(1), two(32) + big(1));
    refuse(fn, L, H, 'min-1', lo - big(1));
    refuse(fn, L, H, 'max+1', hi + big(1));
    refuse(fn, L, H, '2^100', two(100));
    for (const [label, v] of [
      ['number 1', 1],
      ['number 0', 0],
      ['number -0', -0],
      ['number 2^53', 2 ** 53],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['string "1"', '1'],
      ['true', true],
      ['null', null],
      ['undefined', undefined],
    ] as [string, unknown][]) {
      refuse(fn, L, H, label, v);
    }
  }
  // The message is bounded and never runs user code, whatever it is given.
  const hostile = {
    toString() {
      throw new Error('toString ran');
    },
  };
  const r = c(() => m.echo_i32(hostile));
  cases++;
  if (r.cls !== 'TypeError')
    problems.push(`echo_i32(object with a throwing toString) gave ${JSON.stringify(r)}`);
  const huge = c(() => m.echo_i64(two(200000)));
  cases++;
  if (huge.cls !== 'TypeError' || String(huge.message).length > 300) {
    problems.push(`echo_i64(2^200000) echoed ${String(huge.message).length} characters`);
  }
  // A refused call leaves the library usable.
  accept('echo_i32', 'after the refusals', 7, 7);
  return { cases, problems };
}
