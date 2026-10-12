/**
 * Semantic-version parsing and precedence (semver 2.0.0, section 11), the only
 * part of semver this package needs: ordering two contract versions.
 *
 * Deliberately strict. A version the parser does not accept is `undefined`,
 * and comparing one throws — the callers (the skew rule) treat "cannot tell"
 * as a failure, never as a guess.
 */

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Prerelease identifiers; numeric ones are numbers. Empty for a release. */
  readonly prerelease: readonly (string | number)[];
}

const NUM = '(0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const VERSION_RE = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
);

/** Parse `MAJOR.MINOR.PATCH[-prerelease][+build]`, or `undefined`. */
export function parseVersion(input: string): Version | undefined {
  const m = VERSION_RE.exec(input);
  if (!m) return undefined;
  const prerelease =
    m[4] === undefined ? [] : m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

function sign(n: number): -1 | 0 | 1 {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

function comparePrerelease(a: Version['prerelease'], b: Version['prerelease']): -1 | 0 | 1 {
  // A release outranks any prerelease of the same MAJOR.MINOR.PATCH.
  if (a.length === 0 || b.length === 0) return sign(b.length - a.length);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return sign(x - y);
    // Numeric identifiers sort before alphanumeric ones.
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** -1 if a < b, 0 if equal precedence, 1 if a > b. Throws on a non-version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va) throw new Error(`"${a}" is not a version (expected MAJOR.MINOR.PATCH)`);
  if (!vb) throw new Error(`"${b}" is not a version (expected MAJOR.MINOR.PATCH)`);
  return (
    sign(va.major - vb.major) ||
    sign(va.minor - vb.minor) ||
    sign(va.patch - vb.patch) ||
    comparePrerelease(va.prerelease, vb.prerelease)
  );
}
