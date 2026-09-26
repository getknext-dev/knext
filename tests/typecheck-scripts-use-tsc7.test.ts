import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { REPO_ROOT, readManifest, workspaceManifests } from './helpers/workspace-manifests';

/**
 * #1402 — every workspace `typecheck` script that runs the TypeScript
 * compiler runs the `typescript-tsc7` alias, never the plain `typescript`
 * package (still installed at 5.9.x, so a regression fails nothing loudly —
 * it just typechecks on the slow binary).
 *
 * Reading `scripts.typecheck` as a string is not enough: `turbo run
 * typecheck:inner`, `bun run tc` (with `tc` = plain `tsc`) or `echo skipped`
 * all hide what actually runs. So this guard RESOLVES THE SCRIPT CHAIN:
 * `bun run X` / `npm run X` / `pnpm run X` / `yarn run X` follow X in the same
 * package; `turbo run X` follows X in every manifest (root + workspaces) that
 * declares it. An unresolvable hop fails. Every command reached is then
 * classified by its executable TOKEN (not a substring of the script), so
 * `tsc -p tsconfig.typescript-tsc7.json` is plain tsc.
 *
 * Rules:
 *  - no command in any chain may invoke plain tsc: a bare `tsc` token, a
 *    `.bin/tsc`, or anything under the `typescript/` package's `bin/` or
 *    `lib/` (e.g. `node node_modules/typescript/lib/_tsc.js`);
 *  - the known tsc7 consumers' chains MUST reach a typescript-tsc7
 *    invocation (so `echo skipped` there fails);
 *  - scripts that never run a compiler (`packages/kn-next-alias`'s
 *    `node --check`) are otherwise unaffected.
 */

type Scripts = Record<string, string>;
interface Pkg {
  path: string;
  scripts: Scripts;
}

const KNOWN_TSC7_CONSUMERS = [
  'package.json',
  'packages/lib/package.json',
  'packages/db/package.json',
  'packages/kn-next/package.json',
  'packages/ui/package.json',
  'apps/db-demo/package.json',
  'apps/file-manager/package.json',
];

const TSC7_BIN = /(^|\/)typescript-tsc7\/(bin\/tsc|lib\/_?tsc\.js)$/;
const PLAIN_TS_PKG = /(^|\/)typescript\/(bin|lib)\//;
const TSC_LIKE = /(^|\/)(tsc|_?tsc\.js)$/;
const RUNNERS = new Set(['bun', 'npm', 'pnpm', 'yarn']);
const INTERPRETERS = new Set(['node', 'bun', 'npx', 'bunx', 'pnpx', 'exec']);

function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^['"]+|['"]+$/g, ''))
    .filter(Boolean);
}

/** Tokens a reached command would EXECUTE, after env assignments + interpreters. */
function executable(tokens: string[]): string | undefined {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  while (i < tokens.length - 1 && INTERPRETERS.has(tokens[i])) {
    i++;
    while (i < tokens.length - 1 && tokens[i].startsWith('-')) i++;
  }
  return tokens[i];
}

interface Chain {
  tsc7: number;
  plainTsc: string[];
  unresolved: string[];
}

/** Follow `start` (a script name in `pkg`) through run/turbo hops; classify every command. */
function resolveChain(pkg: Pkg, start: string, all: Pkg[]): Chain {
  const out: Chain = { tsc7: 0, plainTsc: [], unresolved: [] };
  const seen = new Set<string>();
  const visit = (p: Pkg, name: string) => {
    const key = `${p.path}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const script = p.scripts[name];
    if (script === undefined) {
      out.unresolved.push(key);
      return;
    }
    for (const command of script.split(/&&|\|\||;|\|/)) {
      const tokens = tokenize(command);
      if (tokens.length === 0) continue;
      // plain-typescript references ANYWHERE in the command (catches `sh -c "tsc"`, `_tsc.js`)
      for (const t of tokens) {
        if (PLAIN_TS_PKG.test(t) || (TSC_LIKE.test(t) && !TSC7_BIN.test(t))) {
          out.plainTsc.push(`${key}: ${command.trim()}`);
        }
      }
      if (tokens[0] === 'turbo' && tokens[1] === 'run' && tokens[2]) {
        const targets = all.filter((q) => q.scripts[tokens[2]] !== undefined);
        if (targets.length === 0) out.unresolved.push(`turbo run ${tokens[2]}`);
        for (const q of targets) visit(q, tokens[2]);
        continue;
      }
      if (RUNNERS.has(tokens[0])) {
        const target = tokens[1] === 'run' ? tokens[2] : tokens[1];
        if (target && (tokens[1] === 'run' || p.scripts[target] !== undefined)) {
          visit(p, target);
          continue;
        }
      }
      const exe = executable(tokens);
      if (exe && TSC7_BIN.test(exe)) out.tsc7++;
    }
  };
  visit(pkg, start);
  return out;
}

function allPackages(): Pkg[] {
  const manifests = [readManifest(resolve(REPO_ROOT, 'package.json')), ...workspaceManifests()];
  return manifests.map(({ path, pkg }) => ({
    path,
    scripts: (pkg.scripts as Scripts | undefined) ?? {},
  }));
}

const PACKAGES = allPackages();
const WITH_TYPECHECK = PACKAGES.filter((p) => p.scripts.typecheck !== undefined);

describe('#1402 — typecheck script chains run typescript-tsc7, never plain tsc', () => {
  it('discovers every known tsc7 consumer (an over-narrowed scan fails here)', () => {
    const found = WITH_TYPECHECK.map((p) => p.path);
    for (const known of KNOWN_TSC7_CONSUMERS) {
      expect(found, `${known}'s typecheck script was not discovered`).toContain(known);
    }
  });

  it.each(
    WITH_TYPECHECK.map((p) => [p.path, p] as const),
  )('%s: the resolved typecheck chain never invokes plain tsc and resolves fully', (_path, pkg) => {
    const chain = resolveChain(pkg, 'typecheck', PACKAGES);
    expect(chain.unresolved, 'unresolvable script hop').toEqual([]);
    expect(chain.plainTsc, 'plain (5.9.x) tsc reached').toEqual([]);
  });

  it.each(
    KNOWN_TSC7_CONSUMERS,
  )('%s: the resolved typecheck chain invokes typescript-tsc7', (path) => {
    const pkg = PACKAGES.find((p) => p.path === path);
    expect(pkg, `${path} not found`).toBeDefined();
    const chain = resolveChain(pkg as Pkg, 'typecheck', PACKAGES);
    expect(
      chain.tsc7,
      `${path}'s typecheck never reaches a typescript-tsc7 invocation`,
    ).toBeGreaterThan(0);
  });
});

describe('#1402 — resolveChain self-test (each known bypass is caught)', () => {
  const pkg = (path: string, scripts: Scripts): Pkg => ({ path, scripts });
  const chainOf = (scripts: Scripts, others: Pkg[] = []) => {
    const root = pkg('root', scripts);
    return resolveChain(root, 'typecheck', [root, ...others]);
  };
  const TSC7 = '../../node_modules/typescript-tsc7/bin/tsc --noEmit';

  it('accepts the direct tsc7 invocation', () => {
    expect(chainOf({ typecheck: TSC7 })).toEqual({ tsc7: 1, plainTsc: [], unresolved: [] });
  });

  it('follows `bun run` / `npm run` / `bun <script>` hops', () => {
    expect(chainOf({ typecheck: 'bun run tc', tc: TSC7 }).tsc7).toBe(1);
    expect(chainOf({ typecheck: 'npm run tc', tc: TSC7 }).tsc7).toBe(1);
    expect(chainOf({ typecheck: 'bun tc', tc: TSC7 }).tsc7).toBe(1);
    expect(chainOf({ typecheck: 'bun run tc', tc: 'tsc --noEmit' }).plainTsc).toHaveLength(1);
  });

  it('follows `turbo run X` into every package declaring X', () => {
    const ws = pkg('packages/a/package.json', { 'typecheck:inner': 'tsc --noEmit' });
    expect(chainOf({ typecheck: 'turbo run typecheck:inner' }, [ws]).plainTsc).toHaveLength(1);
    const ok = pkg('packages/a/package.json', { 'typecheck:inner': TSC7 });
    expect(chainOf({ typecheck: 'turbo run typecheck:inner' }, [ok]).tsc7).toBe(1);
  });

  it('fails an unresolvable hop', () => {
    expect(chainOf({ typecheck: 'bun run nope' }).unresolved).toEqual(['root#nope']);
    expect(chainOf({ typecheck: 'turbo run nope' }).unresolved).toEqual(['turbo run nope']);
  });

  it('flags the plain typescript package bin/lib, including `_tsc.js`', () => {
    expect(
      chainOf({ typecheck: 'node node_modules/typescript/lib/_tsc.js' }).plainTsc,
    ).toHaveLength(1);
    expect(chainOf({ typecheck: 'node_modules/typescript/bin/tsc' }).plainTsc).toHaveLength(1);
    expect(chainOf({ typecheck: 'node_modules/.bin/tsc --noEmit' }).plainTsc).toHaveLength(1);
    expect(chainOf({ typecheck: 'node node_modules/typescript-tsc7/lib/_tsc.js' }).tsc7).toBe(1);
  });

  it('matches the executable token, not a substring (`tsc -p tsconfig.typescript-tsc7.json`)', () => {
    const c = chainOf({ typecheck: 'tsc -p tsconfig.typescript-tsc7.json' });
    expect(c.tsc7).toBe(0);
    expect(c.plainTsc).toHaveLength(1);
  });

  it('a non-compiler script reaches no tsc7 (so `echo skipped` fails for a known consumer)', () => {
    expect(chainOf({ typecheck: 'echo skipped' })).toEqual({
      tsc7: 0,
      plainTsc: [],
      unresolved: [],
    });
    expect(chainOf({ typecheck: 'node --check bin/kn-next.js' }).plainTsc).toEqual([]);
  });
});
