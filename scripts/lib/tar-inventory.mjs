/**
 * A minimal, dependency-free tar (ustar + GNU/PAX extensions) reader.
 *
 * `scripts/ga-tarball-diff.mjs` (#1306) used to extract tarballs to disk with
 * `tar -xzf` and then `readdirSync` the result — which is how three bypasses
 * shipped in review: `readdirSync`'s `Dirent` only reports `isFile()`/
 * `isDirectory()`, so a SYMLINK entry (e.g. `package/dist/link.js ->
 * /etc/passwd`) was silently skipped by the walker; nothing ever read a file's
 * MODE, so a 644->755 permission change was invisible; and the walk only ever
 * looked inside the extracted `package/` directory, so a tarball entry rooted
 * OUTSIDE it (`evil/dist/index.js`) was extracted to disk but never compared
 * — never even rejected.
 *
 * The fix is to stop touching disk at all for the diff: read the tar stream
 * directly and get the type, mode, and link target of every entry, plus its
 * content for regular files, entirely in memory. `readTarEntries` is that
 * reader — a plain ustar/PAX parser, so it works from a Buffer in a test with
 * no `tar` binary involved.
 */

import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

const TYPEFLAG = {
  0: 'file',
  '\0': 'file',
  1: 'hardlink',
  2: 'symlink',
  3: 'char',
  4: 'block',
  5: 'directory',
  6: 'fifo',
  7: 'file', // contiguous file — content-bearing, same as a regular file for our purposes
};

function cstr(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function octal(buf, start, len) {
  const raw = cstr(buf, start, len).trim();
  if (raw === '') return 0;
  return Number.parseInt(raw, 8);
}

/** Parse a PAX extended-header body ("<len> <key>=<value>\n" records) into a Map. */
function parsePaxRecords(data) {
  const text = data.toString('utf8');
  const records = new Map();
  let offset = 0;
  while (offset < text.length) {
    const spaceIdx = text.indexOf(' ', offset);
    if (spaceIdx === -1) break;
    const len = Number.parseInt(text.slice(offset, spaceIdx), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(offset, offset + len);
    const eq = record.indexOf('=');
    if (eq !== -1) {
      const key = record.slice(spaceIdx - offset + 1, eq);
      const value = record.slice(eq + 1).replace(/\n$/, '');
      records.set(key, value);
    }
    offset += len;
  }
  return records;
}

/**
 * Read every entry of a gzip-compressed tar archive.
 *
 * @param {Buffer} gzBuffer
 * @returns {Array<{name: string, type: string, mode: number, linkname: string|null, size: number, data: Buffer|null}>}
 */
export function readTarEntries(gzBuffer) {
  const buf = gunzipSync(gzBuffer);
  const entries = [];

  let offset = 0;
  let pendingLongName = null;
  let pendingLongLink = null;
  let pendingPax = null; // Map, applies to the NEXT entry only
  let globalPax = null; // Map, persists until replaced

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) {
      offset += BLOCK;
      continue; // end-of-archive padding block
    }

    const rawName = cstr(header, 0, 100);
    if (rawName === '') {
      offset += BLOCK;
      continue;
    }
    const mode = octal(header, 100, 8) & 0o7777;
    const size = octal(header, 124, 12);
    const typeflagChar = String.fromCharCode(header[156] || 0);
    const rawLinkname = cstr(header, 157, 100);
    const magic = cstr(header, 257, 6);
    const prefix = magic.startsWith('ustar') ? cstr(header, 345, 155) : '';

    offset += BLOCK;
    const data = size > 0 ? buf.subarray(offset, offset + size) : Buffer.alloc(0);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (typeflagChar === 'L') {
      pendingLongName = cstr(data, 0, data.length);
      continue;
    }
    if (typeflagChar === 'K') {
      pendingLongLink = cstr(data, 0, data.length);
      continue;
    }
    if (typeflagChar === 'g') {
      globalPax = parsePaxRecords(data);
      continue;
    }
    if (typeflagChar === 'x') {
      pendingPax = parsePaxRecords(data);
      continue;
    }

    const pax = pendingPax ?? globalPax;
    let name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    let linkname = pendingLongLink ?? rawLinkname;
    if (pax?.has('path')) name = pax.get('path');
    if (pax?.has('linkpath')) linkname = pax.get('linkpath');

    pendingLongName = null;
    pendingLongLink = null;
    pendingPax = null;

    const type = TYPEFLAG[typeflagChar] ?? `unknown:${typeflagChar}`;
    entries.push({
      name,
      type,
      mode,
      linkname: linkname === '' ? null : linkname,
      size,
      data: type === 'file' ? Buffer.from(data) : null,
    });
  }

  return entries;
}
