import { randomBytes } from 'node:crypto';

/**
 * Upload naming for the file-manager.
 *
 * Two rules, both about not trusting the client's filename:
 *
 * 1. **Validate it.** A name that could escape a prefix (`../x`, `a/b`, a
 *    backslash, a NUL or any control character) or that is not a real name
 *    (empty, only dots) is refused, not rewritten. A browser only ever sends a
 *    bare file name, so anything else is a hand-built request.
 * 2. **Never use it as the storage identity.** The object key (and the row's
 *    unique `name`) is `<random id>-<validated name>`. Two uploads called
 *    `report.pdf` therefore land in two objects and two rows; one upload can
 *    never replace another.
 */

export class InvalidFileNameError extends Error {
  constructor(reason: string) {
    super(`Invalid file name: ${reason}`);
    this.name = 'InvalidFileNameError';
  }
}

/** Longest name accepted; the generated id adds 17 characters in front. */
const MAX_NAME_LENGTH = 255;

// Control characters (C0, DEL and C1) have no business in a file name and some
// (NUL, newline) change how a key is logged, signed or parsed downstream.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Return `raw` when it is a safe, plain file name; throw
 * {@link InvalidFileNameError} otherwise. Never rewrites the input.
 */
export function validateFileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidFileNameError('not a string');
  if (raw.trim() === '') throw new InvalidFileNameError('empty');
  if (raw.length > MAX_NAME_LENGTH) throw new InvalidFileNameError('too long');
  if (CONTROL.test(raw)) throw new InvalidFileNameError('control character');
  if (raw.includes('/') || raw.includes('\\')) throw new InvalidFileNameError('path separator');
  // No separator is left, so `..` can only be a traversal when it is the whole
  // name (or all dots/space); `a..b.txt` is an ordinary name and stays valid.
  if (/^[.\s]+$/.test(raw)) throw new InvalidFileNameError('only dots');
  return raw;
}

/** `<16 hex chars of CSPRNG>-<name>`: unique per upload, never a path. */
export function objectKeyFor(validatedName: string): string {
  return `${randomBytes(8).toString('hex')}-${validatedName}`;
}
