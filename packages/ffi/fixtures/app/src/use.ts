// App code calling the generated module: proves its exported types are usable
// as written (bigint for 64-bit integers, interfaces for records, unions for
// enums, `T | null` for Option) with Node types only.
import {
  add,
  big,
  type Color,
  echo_point,
  FfiLoadError,
  greet,
  maybe,
  type Point,
  parse,
  RustError,
  RustPanicError,
  sum,
} from './generated/ffi';

export function demo(): string {
  const c: Color = 'Red';
  const p: Point = { id: BigInt(1), x: 1.5, label: 'p', tags: [], inner: null, color: c };
  const back: Point = echo_point(p);
  const n: number = add(1, 2);
  const b: bigint = big(BigInt(2) ** BigInt(60));
  const m: bigint | null = maybe(null);
  const s: bigint = sum(new Uint8Array([1, 2, 3]));
  try {
    parse('x');
  } catch (err) {
    if (err instanceof RustError) return `${err.fn}: ${err.message}`;
    if (err instanceof RustPanicError || err instanceof FfiLoadError) throw err;
  }
  return `${greet('World')} ${n} ${b} ${m} ${s} ${back.id}`;
}
