import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * GUARD: a workflow may only invoke a package manager whose lockfile the repo
 * actually carries (#926).
 *
 * THE DEFECT THIS ENDS. `fe28ad9c` ("build: remove pnpm — one package manager,
 * one lockfile") deleted `pnpm-lock.yaml`, and `release.yml` kept running
 * `pnpm install --frozen-lockfile` in three jobs. `--frozen-lockfile` with no
 * lockfile is an immediate hard error, so EVERY job in the npm publish lane died
 * at install — and nothing said so, because `release-lane-liveness.test.ts`
 * asserts the lane's SHAPE (jobs, needs-edges, pins), not that its installer can
 * install. A control reporting success while its subject is inert is the
 * sprint-1 §2.4 class again.
 *
 * SCANNED, NEVER ENUMERATED. The last toolchain move left FOUR workflows
 * installing against nothing (release.yml, release-ghp.yml, and the knext-side
 * installs of test-e2e-deploy.yml and compat-vinext.yml); an enumerated list of
 * those four is how the fifth gets missed. Every tracked workflow is parsed, and
 * every `run:` line that invokes an installer is resolved to the directory it
 * runs in and the lockfile that install mode requires:
 *
 * (The release lanes are fixed alongside this guard; the two harness workflows
 * are owned by PR #917 and carried here as PENDING_FIXES entries that red the
 * moment that PR lands — see below.)
 *
 *   `pnpm install`                  -> pnpm-lock.yaml
 *   `npm ci`                        -> package-lock.json
 *   `bun install --frozen-lockfile` -> bun.lock
 *
 * The lockfile may live at the install's own directory or any ancestor up to the
 * workspace root — that is exactly the discovery walk all three package managers
 * perform, so a workspace-member install against the root lockfile is a pass and
 * an install against NOTHING is a fail.
 *
 * THE EXCEPTION, scoped by checkout path and never by workflow name: the
 * official next.js compat/e2e harness is a checkout of ANOTHER repository, which
 * brings its own pnpm lockfile with it. An install whose working-directory sits
 * inside such a checkout is that repo's toolchain, not ours — but the exception
 * only applies while the workflow really does check that repository out at that
 * path, so it cannot be borrowed to excuse a knext-side install.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** The canonical repo — a checkout of this is "our tree", wherever it lands. */
const SELF_REPOSITORY = 'getknext-dev/knext';

/**
 * Directories that hold a checkout of a FOREIGN repository, which installs with
 * that repo's own toolchain and lockfile.
 *
 * Dated, justified, and verified: an entry only exempts an install when the same
 * workflow contains an `actions/checkout` step with `repository: <repository>`
 * and `path: <path>`, and a stale entry (matching no install anywhere) reds the
 * usage assertion below rather than lingering as a hole.
 */
const FOREIGN_CHECKOUTS: ReadonlyArray<{ path: string; repository: string; note: string }> = [
  {
    path: 'next.js',
    repository: 'vercel/next.js',
    // 2026-09-05 (#926): the official Next.js compat/e2e harness. next.js is a
    // pnpm workspace of its own — `corepack pnpm install` there resolves against
    // next.js's pnpm-lock.yaml, which its checkout brings with it. That is
    // next.js's toolchain, not knext's, so this guard has nothing to say about
    // it. Scoped by working-directory + verified checkout, NEVER by workflow
    // name: the same two workflows also install knext's own tree, and those
    // installs stay fully in scope.
    note: 'official next.js harness — its own repo, its own pnpm lockfile',
  },
];

/**
 * Known-broken install sites OWNED BY ANOTHER, UNMERGED PR — acknowledged here
 * so this guard can land without crossing that PR's blast radius, and
 * SELF-ENFORCING the way a write-licence is: each entry must still match a live
 * violation. The moment the owning PR lands (the pnpm install is gone), the
 * entry stops matching and the staleness assertion below REDS until it is
 * deleted. An entry can therefore document a known hole, but never outlive it.
 */
const PENDING_FIXES: ReadonlyArray<{
  workflow: string;
  jobId: string;
  command: string;
  note: string;
}> = [
  {
    workflow: '.github/workflows/test-e2e-deploy.yml',
    jobId: 'build-next',
    command: 'pnpm install --frozen-lockfile',
    // 2026-09-05 (#926): fixed by PR #917 (green, unmerged at time of writing).
    // Remove this entry when it lands — the staleness assertion will insist.
    note: 'fixed by PR #917, unmerged at time of writing',
  },
  {
    workflow: '.github/workflows/compat-vinext.yml',
    jobId: 'build-next',
    command: 'pnpm install --frozen-lockfile',
    // 2026-09-05 (#926): same PR, same fix, same removal obligation.
    note: 'fixed by PR #917, unmerged at time of writing',
  },
];

interface Installer {
  tool: string;
  lockfile: string;
  matches: (line: string) => boolean;
}

/** A command position: start of line/literal, or after a separator — never a substring of prose. */
const cmd = (re: RegExp) => (line: string) => re.test(line);

/**
 * Alias coverage is part of the scan thesis (#942 F4): `pnpm i`, `bun i`,
 * `npm clean-install` and yarn's frozen modes are the same defect spelled
 * differently, and a matcher that knows only the spelling that already bit is
 * an enumeration wearing a scan's clothes. `npm install`/`pnpm add` etc. stay
 * out of scope — they do not REQUIRE a lockfile, so a missing one is drift
 * there, not death.
 */
const INSTALLERS: readonly Installer[] = [
  {
    tool: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    matches: cmd(/(?:^|[\s;&|(])pnpm\s+(?:install|i)\b/),
  },
  {
    tool: 'npm',
    lockfile: 'package-lock.json',
    matches: cmd(/(?:^|[\s;&|(])npm\s+(?:ci|clean-install|install-clean)\b/),
  },
  {
    tool: 'bun',
    lockfile: 'bun.lock',
    matches: (line) =>
      /(?:^|[\s;&|(])bun\s+(?:install|i)\b/.test(line) && line.includes('--frozen-lockfile'),
  },
  {
    tool: 'yarn',
    lockfile: 'yarn.lock',
    // Classic `--frozen-lockfile`, berry `--immutable`; bare `yarn` with either
    // flag is also an install.
    matches: (line) =>
      /(?:^|[\s;&|(])yarn\b/.test(line) && /--(?:immutable|frozen-lockfile)\b/.test(line),
  },
];

interface InstallHit {
  workflow: string;
  line: number;
  jobId: string;
  command: string;
  tool: string;
  lockfile: string;
  workingDirectory: string;
  /** The FOREIGN_CHECKOUTS path that exempted this install, if any. */
  exemptedBy: string | null;
  /** The PENDING_FIXES note covering this (real) violation, if any. */
  pendingFix: string | null;
  /** Why this install cannot work, if it cannot. */
  problem: string | null;
}

function trackedWorkflowFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--', '.github/workflows/*.yml', '.github/workflows/*.yaml'],
    { cwd: REPO_ROOT },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
}

const normalizeDir = (dir: string): string => {
  let d = dir.trim();
  while (d.startsWith('./')) d = d.slice(2);
  while (d.endsWith('/')) d = d.slice(0, -1);
  return d === '' ? '.' : d;
};

const underDir = (wd: string, base: string): boolean =>
  base === '.' || wd === base || wd.startsWith(`${base}/`);

/**
 * Every TRACKED file, so lockfile existence is judged against what CI will
 * check out — an untracked local lockfile must not make this green here and
 * red in CI (the corpus above is `git ls-files` for the same reason).
 */
const TRACKED_FILES: ReadonlySet<string> = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean),
);

/**
 * True when `lockfile` is TRACKED at `dir` or any ancestor up to the repo root
 * — the same upward workspace-root discovery pnpm, npm and bun all perform.
 */
function lockfileReachable(dir: string, lockfile: string): boolean {
  let current = dir;
  for (;;) {
    if (TRACKED_FILES.has(current === '.' ? lockfile : `${current}/${lockfile}`)) return true;
    if (current === '.') return false;
    const parent = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '.';
    current = parent;
  }
}

type Step = Record<string, unknown> & { with?: Record<string, unknown> };
type Job = Record<string, unknown> & { steps?: Step[] };

const stepsOf = (job: Job): Step[] => (Array.isArray(job.steps) ? job.steps : []);

const runDefaultWd = (owner: Record<string, unknown> | undefined): string | undefined => {
  const defaults = owner?.defaults as Record<string, unknown> | undefined;
  const run = defaults?.run as Record<string, unknown> | undefined;
  const wd = run?.['working-directory'];
  return typeof wd === 'string' ? wd : undefined;
};

/** Best-effort 1-based line number of a run line, for the failure message. */
function lineNumberOf(rawLines: string[], needle: string): number {
  const idx = rawLines.findIndex((l) => l.includes(needle));
  return idx === -1 ? 0 : idx + 1;
}

function scanWorkflow(file: string): InstallHit[] {
  const raw = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  const rawLines = raw.split('\n');
  const doc = parse(raw) as Record<string, unknown>;
  const jobs = (doc?.jobs ?? {}) as Record<string, Job>;
  const hits: InstallHit[] = [];

  // Where does this workflow put checkouts? Workflow-scoped on purpose: the
  // harness workflows check next.js out ONCE and later jobs reach the same tree
  // via caches/artifacts, so a job-scoped map would miss the re-install steps.
  const selfPaths = new Set<string>();
  const foreignHere = new Map<string, string>();
  for (const job of Object.values(jobs)) {
    for (const step of stepsOf(job)) {
      if (typeof step.uses !== 'string' || !step.uses.startsWith('actions/checkout@')) continue;
      const repository = step.with?.repository;
      const checkoutPath = normalizeDir(typeof step.with?.path === 'string' ? step.with.path : '.');
      if (repository === undefined || repository === SELF_REPOSITORY) selfPaths.add(checkoutPath);
      else foreignHere.set(checkoutPath, String(repository));
    }
  }

  for (const [jobId, job] of Object.entries(jobs)) {
    for (const step of stepsOf(job)) {
      if (typeof step.run !== 'string') continue;
      const stepWd = step['working-directory'];
      const wd = normalizeDir(
        (typeof stepWd === 'string' ? stepWd : undefined) ??
          runDefaultWd(job) ??
          runDefaultWd(doc) ??
          '.',
      );
      for (const runLine of step.run.split('\n')) {
        const trimmed = runLine.trim();
        // Bash comments inside the block scalar are never commands.
        if (trimmed.startsWith('#')) continue;
        // Quoted text is DATA: blank it before matching, so a log line QUOTING
        // an install command cannot match (the harness retry loops print
        // exactly such lines) — while an installer CHAINED after an echo still
        // can. #942 F3: the old leading-`echo ` skip dropped the WHOLE line,
        // leaving `echo "…" && pnpm install --frozen-lockfile` silently exempt
        // (proved red-first: planted exactly that on the publish path and this
        // guard stayed green).
        const blanked = trimmed.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
        // Per-command segmentation: `echo` consumes only ITS OWN arguments, not
        // whatever follows the next shell separator.
        const segments = blanked.split(/&&|\|\||[;|]/);
        for (const segment of segments) {
          const command = segment.trim();
          if (command === 'echo' || command.startsWith('echo ')) continue;
          for (const installer of INSTALLERS) {
            if (!installer.matches(command)) continue;
            const hit: InstallHit = {
              workflow: file,
              line: lineNumberOf(rawLines, runLine.trimEnd() === '' ? command : runLine),
              jobId,
              command,
              tool: installer.tool,
              lockfile: installer.lockfile,
              workingDirectory: wd,
              exemptedBy: null,
              pendingFix: null,
              problem: null,
            };
            const exception = FOREIGN_CHECKOUTS.find((e) => underDir(wd, e.path));
            if (exception) {
              if (foreignHere.get(exception.path) === exception.repository) {
                hit.exemptedBy = exception.path;
              } else {
                hit.problem =
                  `sits under the '${exception.path}' foreign-checkout exception, but this ` +
                  `workflow never checks out ${exception.repository} at that path — the ` +
                  'exception cannot be borrowed for a directory that is not that checkout';
              }
            } else if (wd.includes('${{')) {
              hit.problem =
                `runs in the dynamic working-directory '${wd}', which this guard cannot ` +
                'resolve to a lockfile. Use a static path, or add a scoped exception with a dated note.';
            } else {
              const selfBase = [...selfPaths]
                .filter((p) => underDir(wd, p))
                .sort((a, b) => b.length - a.length)[0];
              if (selfBase === undefined) {
                hit.problem =
                  `runs in '${wd}', which is neither inside a checkout of ${SELF_REPOSITORY} ` +
                  'nor a declared foreign-checkout exception — there is nothing there to install';
              } else {
                const repoDir =
                  selfBase === '.' ? wd : wd === selfBase ? '.' : wd.slice(selfBase.length + 1);
                if (!lockfileReachable(repoDir, installer.lockfile)) {
                  hit.problem =
                    `needs ${installer.lockfile}, which exists neither at '${repoDir}' nor any ` +
                    'ancestor — this install DIES on its first run, and every step after it is dead ' +
                    'code. Install with the package manager whose lockfile the repo actually carries.';
                }
              }
            }
            // A PENDING_FIXES entry may cover a REAL violation (never a healthy
            // install): the hole stays documented here instead of red, and the
            // staleness assertion below forces the entry out when the fix lands.
            if (hit.problem !== null) {
              const pending = PENDING_FIXES.find(
                (p) => p.workflow === file && p.jobId === jobId && p.command === command,
              );
              if (pending) {
                hit.pendingFix = pending.note;
                hit.problem = null;
              }
            }
            hits.push(hit);
          }
        }
      }
    }
  }
  return hits;
}

const format = (h: InstallHit): string =>
  `${h.workflow}:${h.line} [job ${h.jobId}, cwd ${h.workingDirectory}] \`${h.command}\` — ${h.problem}`;

describe('#926 every workflow install command has a lockfile it can actually install from', () => {
  const files = trackedWorkflowFiles();
  const hits = files.flatMap(scanWorkflow);

  it('non-vacuity: the scan sees the real workflow corpus and real install commands', () => {
    // If either floor fails, the assertions below are about nothing: an empty
    // corpus or a matcher that stopped matching would report zero violations
    // forever. 15 is well under today's 22 workflows but far above "the glob
    // broke"; the install floor is deliberately > 0 rather than an exact count,
    // which would make every legitimate lane addition edit this file.
    expect(files.length, 'tracked workflow corpus collapsed').toBeGreaterThan(15);
    expect(hits.length, 'no install commands matched at all').toBeGreaterThan(0);
  });

  it('no workflow installs against a lockfile the repo does not carry', () => {
    expect(hits.filter((h) => h.problem !== null).map(format)).toEqual([]);
  });

  it('every PENDING_FIXES entry still covers a LIVE violation — the entry dies with the defect', () => {
    // Self-enforcing staleness: an entry exists only to acknowledge a violation
    // another (unmerged) PR owns. When that PR lands, the violation disappears,
    // the entry matches nothing, and this REDS until the entry is deleted — so
    // the ledger can never quietly become a standing exemption.
    for (const pending of PENDING_FIXES) {
      expect(
        hits.some(
          (h) =>
            h.pendingFix !== null &&
            h.workflow === pending.workflow &&
            h.jobId === pending.jobId &&
            h.command === pending.command,
        ),
        `PENDING_FIXES entry for ${pending.workflow} [job ${pending.jobId}] ` +
          `\`${pending.command}\` covers no live violation — its fix has landed ` +
          `(${pending.note}), so DELETE the entry`,
      ).toBe(true);
    }
  });

  it('every foreign-checkout exception is still exercised — a stale one is a hole, not a convenience', () => {
    for (const exception of FOREIGN_CHECKOUTS) {
      expect(
        hits.some((h) => h.exemptedBy === exception.path),
        `FOREIGN_CHECKOUTS['${exception.path}'] (${exception.repository}) exempts nothing — ` +
          'remove it, or the next knext-side install placed there inherits an exemption it never argued for',
      ).toBe(true);
    }
  });
});
