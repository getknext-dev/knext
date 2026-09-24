/**
 * Read a tarball's entries with the SAME library `npm`/`pacote` extract with
 * — `node-tar` — instead of a hand-written parser.
 *
 * `scripts/lib/tar-inventory.mjs` (the previous version of this module) was a
 * from-scratch ustar/PAX reader. Round 2 of review reproduced a PARSER
 * DIFFERENTIAL against it: a crafted tarball where the hand parser's view of
 * an entry (or of whether an entry exists at all) disagreed with what
 * `node-tar` — what a real `npm install` actually runs — would do. That is
 * the textbook "TOCTOU via a second implementation" bug class, and patching
 * the hand parser one case at a time is exactly the failure mode the
 * previous three review rounds already lived through (each round's fix
 * introduced the next round's bypass). The only construction that ELIMINATES
 * a parser differential is not having two parsers: this reads entries with
 * the real extractor, in list-only mode, so nothing ever touches disk.
 *
 * FAIL-CLOSED BY CONSTRUCTION
 * ---------------------------
 * `strict: true` turns every `node-tar` warning (`TAR_ENTRY_INVALID` for a
 * bad checksum, an unsupported entry type, `TAR_ENTRY_INFO` for an absolute
 * link target being sanitised, and so on — see `node_modules/tar`'s
 * `warn-method.js`) into a thrown `error` instead of a swallowed `warn`
 * event, which is what let a bad-checksum DUPLICATE entry hide a malicious
 * first copy in review round 2's attack A. `onwarn` additionally throws, as
 * a second, independent fail-closed path in case some future node-tar
 * release moves a check outside the `strict` gate.
 *
 * `strict`/`onwarn` do NOT cover everything, though — measured directly
 * against this exact version of `node-tar` (see the test suite, which
 * documents each finding against the installed version rather than trusting
 * a changelog):
 *
 *   - `tar.list()` (unlike `tar.x()`) never re-derives a path from a
 *     ustar `prefix` + an EMPTY `name`, so an attack shaped like review round
 *     2's attack B — an empty-`name` header carrying the real path only in
 *     `prefix`, retargeted to a symlink — surfaces as an entry whose `path`
 *     is exactly what `prefix` + `'/'` + `''` produces (a trailing-slash
 *     path), with its real, unsanitised, ABSOLUTE `linkpath` intact. Nothing
 *     in node-tar's `list` mode rejects that on its own — `assertEntrySafe`
 *     (`scripts/lib/ga-tarball-diff.mjs`) still has to.
 *   - `list()` delivers a legitimately-checksummed DUPLICATE path as two
 *     separate `onentry` calls, no warning at all — round 2 attack A's
 *     "duplicates keep the last entry" bug is not something `strict` closes;
 *     `readTarEntries` rejects a second occurrence of a path outright, here.
 *   - a header whose `size` field decodes to `NaN` is silently normalised to
 *     `0` by `node-tar`'s own header parser (`nanUndef` in `header.js`) —
 *     if that entry is the LAST one in the archive, `list()` neither warns
 *     nor throws; it just delivers a truncated, empty entry. This is not a
 *     differential (a real extract truncates identically, because it is the
 *     same library), so `readTarEntries` does not — and cannot — "fix" it;
 *     what it guarantees is that OUR view matches what would actually be
 *     installed, so the tree-diff step still catches the truncation as an
 *     ordinary content mismatch against the rc side. See the size-guard test
 *     for the belt-and-suspenders explicit check on `entry.size` itself.
 */

import * as tar from 'tar';

const NODE_TAR_TYPE_TO_ENTRY_TYPE = {
  File: 'file',
  ContiguousFile: 'file',
  Directory: 'directory',
  SymbolicLink: 'symlink',
  Link: 'hardlink',
};

/**
 * @param {string} tgzPath
 * @returns {Array<{name: string, type: string, mode: number, linkname: string|null, size: number, data: Buffer|null}>}
 */
export function readTarEntries(tgzPath) {
  const entries = [];
  const seenPaths = new Set();

  tar.list({
    file: tgzPath,
    sync: true,
    strict: true,
    onwarn: (code, message) => {
      throw new Error(`node-tar warning treated as fatal: ${code}: ${message}`);
    },
    onentry: (entry) => {
      if (seenPaths.has(entry.path)) {
        throw new Error(`duplicate tar entry path (rejected, not de-duplicated): ${entry.path}`);
      }
      seenPaths.add(entry.path);

      const chunks = [];
      entry.on('data', (chunk) => chunks.push(chunk));
      entry.on('end', () => {
        const type = NODE_TAR_TYPE_TO_ENTRY_TYPE[entry.type] ?? `unknown:${entry.type}`;
        const size = entry.size ?? 0;
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error(`tar entry ${entry.path} has an invalid size (${size})`);
        }
        entries.push({
          name: entry.path,
          type,
          mode: (entry.mode ?? 0) & 0o7777,
          linkname: entry.linkpath || null,
          size,
          data: type === 'file' ? Buffer.concat(chunks) : null,
        });
      });
    },
  });

  return entries;
}
