/**
 * The libc check behind `knext ffi build` (ADR-0069 D14 step 3): read the
 * `DT_NEEDED` entries of a built shared library and refuse anything the musl
 * image cannot provide.
 *
 * A pure parser over the bytes, reading what the dynamic loader reads: the
 * program headers, the `PT_DYNAMIC` segment, and the dynamic string table it
 * points at (a virtual address, mapped back to a file offset through the
 * `PT_LOAD` segments). Section headers are not used, so a stripped library
 * parses the same. 64-bit little-endian only: both image targets are.
 */

/** The ELF machine of a target triple's architecture. */
const MACHINES: Record<number, string> = { 62: 'x86_64', 183: 'aarch64' };

export class ElfError extends Error {
  override name = 'ElfError';
}

export interface ElfInfo {
  /** `x86_64` or `aarch64`. */
  readonly arch: string;
  /** Every `DT_NEEDED` name, in file order. */
  readonly needed: readonly string[];
}

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;

/** Parse an ELF64 little-endian shared library's machine and `DT_NEEDED` list. */
export function readElf(bytes: Uint8Array): ElfInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (end: number, what: string) => {
    if (end > bytes.byteLength) throw new ElfError(`truncated ELF file (${what})`);
  };
  need(64, 'header');
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new ElfError('not an ELF file');
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    throw new ElfError('not a 64-bit little-endian ELF file (both image targets are)');
  }
  const machine = view.getUint16(18, true);
  const arch = MACHINES[machine];
  if (arch === undefined) throw new ElfError(`unsupported ELF machine ${machine}`);

  const phoff = Number(view.getBigUint64(32, true));
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  if (phentsize < 56) throw new ElfError('malformed program header size');
  need(phoff + phentsize * phnum, 'program headers');

  const loads: { offset: number; vaddr: number; filesz: number }[] = [];
  let dyn: { offset: number; size: number } | undefined;
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    const type = view.getUint32(at, true);
    const offset = Number(view.getBigUint64(at + 8, true));
    const vaddr = Number(view.getBigUint64(at + 16, true));
    const filesz = Number(view.getBigUint64(at + 32, true));
    if (type === PT_LOAD) loads.push({ offset, vaddr, filesz });
    if (type === PT_DYNAMIC) dyn = { offset, size: filesz };
  }
  if (dyn === undefined) throw new ElfError('no dynamic segment: not a shared library');
  need(dyn.offset + dyn.size, 'dynamic segment');

  const neededOffsets: bigint[] = [];
  let strtab: bigint | undefined;
  let strsz: bigint | undefined;
  for (let at = dyn.offset; at + 16 <= dyn.offset + dyn.size; at += 16) {
    const tag = view.getBigInt64(at, true);
    const val = view.getBigUint64(at + 8, true);
    if (tag === DT_NULL) break;
    if (tag === DT_NEEDED) neededOffsets.push(val);
    else if (tag === DT_STRTAB) strtab = val;
    else if (tag === DT_STRSZ) strsz = val;
  }
  if (neededOffsets.length === 0) return { arch, needed: [] };
  if (strtab === undefined || strsz === undefined) {
    throw new ElfError('dynamic segment has DT_NEEDED entries but no string table');
  }
  const vaddr = Number(strtab);
  const seg = loads.find((l) => vaddr >= l.vaddr && vaddr < l.vaddr + l.filesz);
  if (seg === undefined) throw new ElfError('dynamic string table is outside every segment');
  const strOff = seg.offset + (vaddr - seg.vaddr);
  const strEnd = strOff + Number(strsz);
  need(strEnd, 'dynamic string table');

  const decoder = new TextDecoder();
  const needed = neededOffsets.map((o) => {
    const start = strOff + Number(o);
    let end = start;
    while (end < strEnd && bytes[end] !== 0) end++;
    if (end >= strEnd) throw new ElfError('unterminated DT_NEEDED name');
    return decoder.decode(bytes.subarray(start, end));
  });
  return { arch, needed };
}

/**
 * What a musl image provides (D14 step 3): `libc.so` (what cargo-zigbuild
 * emits, measured), musl's own sonames, and `libgcc_s.so.1` (every knext Bun
 * stage installs libgcc).
 */
export function allowedNeeded(arch: string): ReadonlySet<string> {
  return new Set(['libc.so', `libc.musl-${arch}.so.1`, `ld-musl-${arch}.so.1`, 'libgcc_s.so.1']);
}

/** The architecture a Rust target triple names (`x86_64-unknown-linux-musl` → `x86_64`). */
export function tripleArch(triple: string): string {
  return triple.split('-')[0] as string;
}

/**
 * Refuse a library that would not load on the musl image for `triple`:
 * a different architecture, or any `DT_NEEDED` outside the allowlist (a
 * glibc `libc.so.6` / `ld-linux-*` is the crash this prevents). Returns the
 * needed list on success.
 */
export function assertMuslLibrary(bytes: Uint8Array, triple: string, label: string): string[] {
  let info: ElfInfo;
  try {
    info = readElf(bytes);
  } catch (err) {
    throw new ElfError(`${label}: ${(err as Error).message}`);
  }
  const arch = tripleArch(triple);
  if (info.arch !== arch) {
    throw new ElfError(`${label} is built for ${info.arch}, but the target ${triple} is ${arch}`);
  }
  const allowed = allowedNeeded(arch);
  const bad = info.needed.filter((n) => !allowed.has(n));
  if (bad.length > 0) {
    throw new ElfError(
      `${label} links ${bad.join(', ')}, which the musl (Alpine) image does not have. ` +
        `A library for ${triple} may link only ${[...allowed].join(', ')}. ` +
        'A glibc library (libc.so.6, ld-linux-*) crashes on the image; build with `knext ffi build`, which cross-compiles against musl.',
    );
  }
  return [...info.needed];
}
