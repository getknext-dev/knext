import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defineDrizzleConfig } from '../migrate';

// v3-P3c — the @knext/db peer/dependency shape contract (ADR-0021 amendment,
// supersedes Open decision 6). Two invariants:
//
//   1. `drizzle-orm` is a HARD `dependency` (the package re-exports it — it is a
//      real runtime dep) and is NOT also declared an optional peer. A dependency
//      cannot coherently be both; the duplicate is dropped and the re-exported
//      range is part of @knext/db's semver contract.
//   2. `drizzle-kit` stays an OPTIONAL peer, LAZILY resolved only inside
//      `defineDrizzleConfig`. The main entry (`@knext/db`) and the migration
//      runner (`runMigrations`) must import + run WITHOUT drizzle-kit installed;
//      touching `defineDrizzleConfig` without it yields an ACTIONABLE named-peer
//      error, never a bare ERR_MODULE_NOT_FOUND.

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

describe('@knext/db package.json — dependency / peer shape (v3-P3c)', () => {
  it('declares drizzle-orm as a hard runtime dependency', () => {
    expect(pkg.dependencies?.['drizzle-orm']).toBeTruthy();
    expect(typeof pkg.dependencies['drizzle-orm']).toBe('string');
  });

  it('does NOT also declare drizzle-orm as a peer (a dep cannot be both)', () => {
    expect(pkg.peerDependencies?.['drizzle-orm']).toBeUndefined();
    expect(pkg.peerDependenciesMeta?.['drizzle-orm']).toBeUndefined();
  });

  it('keeps drizzle-kit as an OPTIONAL peer dependency', () => {
    expect(pkg.peerDependencies?.['drizzle-kit']).toBeTruthy();
    expect(pkg.peerDependenciesMeta?.['drizzle-kit']?.optional).toBe(true);
  });
});

describe('@knext/db — defineDrizzleConfig drizzle-kit peer guard (v3-P3c)', () => {
  it('produces a config when drizzle-kit resolves (present)', () => {
    const cfg = defineDrizzleConfig({}, { resolveDrizzleKit: () => '/some/path/drizzle-kit' });
    expect(cfg.dialect).toBe('postgresql');
  });

  it('throws an ACTIONABLE named-peer error (never bare ERR_MODULE_NOT_FOUND) when drizzle-kit is absent', () => {
    const absent = () => {
      const err = new Error("Cannot find module 'drizzle-kit'") as NodeJS.ErrnoException;
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    };
    let thrown: unknown;
    try {
      defineDrizzleConfig({}, { resolveDrizzleKit: absent });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // Names the peer + tells the user exactly how to fix it.
    expect(msg).toMatch(/drizzle-kit/);
    expect(msg).toMatch(/defineDrizzleConfig/);
    expect(msg).toMatch(/devDependency/i);
    // NOT a bare resolver error surfacing raw.
    expect(msg).not.toBe("Cannot find module 'drizzle-kit'");
    expect((thrown as NodeJS.ErrnoException).code).not.toBe('ERR_MODULE_NOT_FOUND');
  });
});

// The real-world contract: load the BUILT @knext/db main entry + the migrate
// runner in a subprocess where `drizzle-kit` cannot resolve, and prove:
//   - `require('@knext/db')` succeeds (re-exports drizzle-orm) — no drizzle-kit.
//   - `runMigrations` is importable and reachable (guards the DSN with no db).
//   - `defineDrizzleConfig()` (the ONE surface that needs drizzle-kit) throws the
//     actionable named error, NOT a bare MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND.
// Mechanism: a child node process with a CJS `--require` preload that patches
// Module._resolveFilename so `drizzle-kit` (and only it) is unresolvable — the
// same choke point the compiled `require.resolve('drizzle-kit')` probe hits.
describe('@knext/db — built main entry loads with drizzle-kit ABSENT (v3-P3c)', () => {
  const distIndex = join(pkgDir, 'dist', 'index.js');
  const distMigrate = join(pkgDir, 'dist', 'migrate.js');
  const preload = join(pkgDir, 'src', '__tests__', 'fixtures', 'hide-drizzle-kit.cjs');

  it('main entry + runMigrations load without drizzle-kit; defineDrizzleConfig errors actionably', () => {
    const script = [
      // Prove the preload actually hides drizzle-kit (guards against a no-op fixture).
      `let hidden = false;`,
      `try { require.resolve('drizzle-kit'); } catch { hidden = true; }`,
      `if (!hidden) { console.error('DRIZZLE_KIT_STILL_RESOLVES'); process.exit(2); }`,
      `const idx = require(${JSON.stringify(distIndex)});`,
      `if (typeof idx.getDb !== 'function') { console.error('NO_GETDB'); process.exit(3); }`,
      `if (typeof idx.eq !== 'function') { console.error('NO_DRIZZLE_REEXPORT'); process.exit(4); }`,
      `const mig = require(${JSON.stringify(distMigrate)});`,
      `if (typeof mig.runMigrations !== 'function') { console.error('NO_RUNMIGRATIONS'); process.exit(5); }`,
      // runMigrations must be reachable (it guards on the DSN with no db needed).
      `let dsnGuarded = false;`,
      `try { mig.resolveWriterDsn({ url: '' }); } catch (e) { dsnGuarded = /DATABASE_URL/.test(e.message); }`,
      `if (!dsnGuarded) { console.error('RUNMIGRATIONS_UNREACHABLE'); process.exit(6); }`,
      // defineDrizzleConfig is the only surface that needs drizzle-kit — it must
      // throw the actionable named error, NOT a bare (ERR_)MODULE_NOT_FOUND.
      `let ok = false;`,
      `try { mig.defineDrizzleConfig(); console.error('DID_NOT_THROW'); process.exit(7); }`,
      `catch (e) { ok = /drizzle-kit/.test(e.message) && /devDependency/i.test(e.message) && e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'MODULE_NOT_FOUND'; }`,
      `if (!ok) { console.error('WRONG_ERROR'); process.exit(8); }`,
      `console.log('OK');`,
    ].join('\n');

    const out = execFileSync(process.execPath, ['--require', preload, '-e', script], {
      encoding: 'utf8',
      cwd: pkgDir,
    });
    expect(out.trim()).toContain('OK');
  });
});
