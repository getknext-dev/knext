import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parse } from 'yaml';
import { splitSourceIntoStatements } from './shell-statements';

/**
 * Engine for `tests/publish-lane-supply-chain.test.ts` (#2044, v2 task R8).
 *
 * Question asked of a directory of workflows: does EVERY job that can publish to
 * npm transitively `needs` (a) the npm-audit gate and (b) the SBOM job?
 *
 * ## Discovery is INVERTED: over-match, then allowlist (round 2)
 *
 * Round 1 recognised publish lanes by enumerating COMMAND FORMS (`npm publish`,
 * `changeset publish`, a 4-token window, a known set of wrappers...), and the
 * review built a bypass for every form it did not list: `for d in ..; do npm
 * publish; done`, `npm -w a -w b publish`, `npx @changesets/cli publish`,
 * `xargs npm publish`, `JS-DevTools/npm-publish`, a continuation-split `|| true`.
 * That is the enumerate-the-forms trap this repo has written down three times.
 *
 * So discovery now asks the opposite question. A job is a lane CANDIDATE if ANY
 * of these holds, and every candidate is a lane that must pass the gates unless
 * it is NAMED in a small reviewed `nonLanes` allowlist (keyed by workflow + job,
 * with a one-line reason; an entry matching no candidate is itself a failure):
 *
 *   1. the word `publish` (also `PUBLISH_CMD`-style variable names and
 *      `publish.sh`-style script names) appears in a `run` statement, after
 *      joining line continuations and dropping comments and `cat`/`tee`/`echo`
 *      heredoc prose;
 *   2. it appears in a `uses:` name, a `with:` value, or an `env:` value (so a
 *      third-party publish action, `nick-fields/retry` with `command: npm
 *      publish`, and `env: CMD: npm publish` are all candidates);
 *   3. a `changesets/action` step carries a `publish`/`publish-script` input;
 *   4. a `<pm> run <script>` whose root `package.json` script body has the word;
 *   5. a local composite action (`uses: ./...`) contains any of the above, or
 *      cannot be read;
 *   6. the job holds the npm credential (`NODE_AUTH_TOKEN`, `secrets.NPM_TOKEN`,
 *      an `npm-publish*` or expression `environment`). This is the sturdy rule:
 *      whatever a credentialed job runs — `$CMD`, `eval`, `bash x.sh`,
 *      `${{ inputs.cmd }}` — it is a candidate, so a form nobody listed cannot
 *      slip past it.
 *
 * Nothing names a workflow file or a job id except the allowlist, and the
 * allowlist can only REMOVE a job from the lane set, visibly, in review.
 *
 * ## The gates are found by what they run, not by job id
 *
 *   - THE AUDIT GATE — a job whose step runs `scripts/audit-published.mjs`
 *     (`npm audit --omit=dev` over the packed production closure) as a bare,
 *     own-line, argument-free statement: after joining continuations it must not
 *     be preceded by anything on its line (a subshell, `a ||`, `!`), followed by
 *     `||`, `;`, `&` or a comment-less remainder, carry ANY argument (`--help`
 *     included; the script takes none), have a later `exit 0`/`true`/`:`, or sit
 *     under `set +e`, a non-bash `shell:`, a step `if`, or any
 *     `continue-on-error`.
 *   - THE SBOM JOB — a job running that same script and uploading a
 *     `*.cdx.json` artifact. The script is the single source of truth for both
 *     the audit and the CycloneDX SBOM, so today one job is both; the guard
 *     requires the lane to reach at least one of each, not two distinct jobs.
 *
 * ## Fail closed
 *
 * A workflow or composite action that cannot be read, cannot be parsed, or
 * parses to something with no `jobs` mapping is a PROBLEM, never "no lanes
 * found". So is a `needs` entry naming a missing job, a missing workflow
 * directory, and a stale or reason-less allowlist entry.
 *
 * ## The `needs` graph
 *
 * An edge `J needs K` is only a gate when J cannot start after K FAILED. A job
 * whose `if` carries `always()`, `failure()` or `cancelled()` does exactly that,
 * so its outgoing edges are dropped from the closure (the lane's own `if`, or an
 * intermediate job's).
 *
 * ## Known blind spots (stated, not dressed up)
 *
 *   - ENV-INDIRECTED and SCRIPT-HIDDEN commands: `run: $CMD`, `eval "$X"`,
 *     `${{ inputs.cmd }}`, `bash ./deploy.sh` that shells to `npm publish`. In an
 *     UNcredentialed job whose text never says `publish` they are invisible.
 *     Over-matching catches most of them anyway (a variable or script NAMED
 *     `*publish*`, an `env:` value that says it), and the credential rule (6)
 *     catches every one in a job that can authenticate to npm — but a
 *     publish done with a token that is not named `NODE_AUTH_TOKEN` /
 *     `NPM_TOKEN` and a command that never says `publish` is not seen.
 *   - Hyphenated names (`publish-all`, `publish-packages`) are NOT matched by the
 *     word rule (they would also match `publish-lane-guard` / `publish-preflight`
 *     on every job here); they are caught by the credential rule or the alias
 *     rule only.
 *   - Reusable workflows are not followed (`jobs.<id>.uses` is scanned for the
 *     word only); a called workflow's own lane is found in its own file.
 *   - `<pm> run` aliases are resolved against the ROOT `package.json` only.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SBOM_PATH = /\.cdx\.json\b/;
const STATUS_BYPASS = /\b(always|failure|cancelled)\s*\(\s*\)/;

/**
 * The word `publish` as a shell word. Not preceded by a letter/digit, not
 * followed by a letter/digit/hyphen: matches `npm publish`, `--publish`,
 * `npm-publish`, `$PUBLISH_CMD`, `inputs.publish_cmd`, `publish.sh`; does NOT
 * match `published`, `publishes`, `publish-lane-guard.mjs`, `publish-preflight`.
 */
const PUBLISH_WORD = /(?<![A-Za-z0-9])publish(?![A-Za-z0-9-])/i;

/** The only argv the audit script takes. It takes none; `--help` must not count. */
const AUDIT_ALLOWED_ARGS: readonly string[] = [];

type Job = Record<string, unknown>;
type Step = Record<string, unknown>;

export interface PublishLane {
  file: string;
  jobId: string;
  /** What made this job a lane candidate, for the failure message. */
  why: string;
}

/** A reviewed "this candidate is not a publish lane" entry. */
export interface NonLane {
  file: string;
  job: string;
  reason: string;
}

export interface PublishLaneAudit {
  problems: string[];
  workflowsSeen: number;
  lanes: PublishLane[];
  /** Candidates excused by the allowlist, `file#jobId`. */
  excused: string[];
  /** `file#jobId` of every non-neutralisable job that runs the audit script. */
  auditJobs: string[];
  /** `file#jobId` of every job that runs the audit script and uploads a CycloneDX SBOM. */
  sbomJobs: string[];
}

export interface AuditOptions {
  workflowDir: string;
  /** Root package.json whose `scripts` resolve `<pm> run <script>`. Default: the repo root's. */
  packageJsonPath?: string;
  /** Repo root, to resolve local composite actions (`uses: ./...`). Default: two levels above `workflowDir`. */
  repoRoot?: string;
  /** The reviewed allowlist of candidates that are not publish lanes. */
  nonLanes?: readonly NonLane[];
}

// ── shell-statement classification ─────────────────────────────────────────

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that run the NEXT command, with optional flags in between. */
const WRAPPERS = new Set([
  'sudo',
  'env',
  'time',
  'exec',
  'command',
  'nohup',
  'npx',
  'bunx',
  'pnpx',
  'corepack',
]);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNERS = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node']);

/** Line continuations joined first, so `a \⏎ || true` is one line to every check. */
const joinContinuations = (source: string): string => source.replace(/\\\r?\n[ \t]*/g, ' ');

function tokenize(statement: string): string[] {
  const raw = statement.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return raw.map((t) => t.replace(/^(["'])(.*)\1$/s, '$2'));
}

/** Drops leading `VAR=val` assignments and wrapper words (+ their flags). */
function commandTokens(tokens: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < tokens.length && ASSIGNMENT.test(tokens[i])) i++;
    if (i < tokens.length && WRAPPERS.has(tokens[i])) {
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * Removes the BODY of a heredoc whose command is a pure text sink (`cat`, `tee`,
 * `echo`, `printf`) — prose such as an issue body that says "npm publish". A
 * heredoc fed to a shell (`bash <<EOF`, `cat <<EOF | sh`) is code and is kept.
 */
function stripProseHeredocs(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /^\s*(cat|tee|echo|printf)\b[^\n]*?<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(
      lines[i],
    );
    if (!m || /\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(lines[i])) continue;
    const delim = m[3];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== delim) j++;
    i = j; // the terminator line is dropped with the body
  }
  return out.join('\n');
}

/** The evidence that `source` (a `run` body) can publish, or null. */
function runEvidence(source: string, scripts: Record<string, string>, depth = 0): string | null {
  if (depth > 5) return null;
  const prepared = stripProseHeredocs(joinContinuations(source));
  for (const { text } of splitSourceIntoStatements(prepared)) {
    const word = PUBLISH_WORD.exec(text);
    if (word) return `run statement \`${text.trim().slice(0, 80)}\``;
    const cmd = commandTokens(tokenize(text));
    const head = cmd[0];
    if (head === undefined || !PACKAGE_MANAGERS.has(head)) continue;
    // `<pm> run <script>` / `pnpm <script>` / `yarn <script>` → the package.json script body
    const rest = cmd.slice(1);
    const run = rest.findIndex((t) => t === 'run' || t === 'run-script');
    const candidates =
      run !== -1
        ? rest.slice(run + 1).filter((t) => !t.startsWith('-'))
        : head === 'pnpm' || head === 'yarn'
          ? rest.filter((t) => !t.startsWith('-')).slice(0, 1)
          : [];
    for (const name of candidates) {
      const body = scripts[name];
      if (typeof body !== 'string') continue;
      const inner = runEvidence(body, scripts, depth + 1);
      if (inner) return `\`${head} run ${name}\` → ${inner}`;
    }
  }
  return null;
}

// ── audit-script recognition ───────────────────────────────────────────────

/** `scripts/audit-published.mjs` pinned to that path (optionally `./`-prefixed). */
const AUDIT_PATH = /^(\.\/)?scripts\/audit-published\.mjs$/;

/** Does `source` run the pinned audit script as a program argument (not prose)? */
function runsAuditScript(source: string): boolean {
  for (const { text } of splitSourceIntoStatements(stripProseHeredocs(joinContinuations(source)))) {
    const cmd = commandTokens(tokenize(text));
    if (cmd[0] === undefined || !RUNNERS.has(cmd[0])) continue;
    if (cmd.slice(1).some((t) => AUDIT_PATH.test(t))) return true;
  }
  return false;
}

/** Strictly: `[VAR=x ...] <runner> [node flags] scripts/audit-published.mjs [allowed args] [# comment]`. */
function isBareAuditLine(line: string): boolean {
  const code = line.replace(/\s+#.*$/, '').trim();
  const tokens = tokenize(code);
  if (tokens.some((t) => /[|;&()`{}<>]/.test(t) || t === '!' || t.includes('$('))) return false;
  const cmd = commandTokens(tokens);
  if (
    cmd.length === 0 ||
    tokens.slice(0, tokens.length - cmd.length).some((t) => !ASSIGNMENT.test(t))
  ) {
    return false;
  }
  if (!RUNNERS.has(cmd[0])) return false;
  const at = cmd.findIndex((t) => AUDIT_PATH.test(t));
  if (at === -1) return false;
  if (cmd.slice(1, at).some((t) => !t.startsWith('-'))) return false; // something before the script
  const args = cmd.slice(at + 1);
  return args.every((a) => AUDIT_ALLOWED_ARGS.includes(a));
}

/** Why the run body's audit invocation can NOT be relied on to fail the step (null = it can). */
function auditInvocationProblem(run: string): string | null {
  const joined = stripProseHeredocs(joinContinuations(run));
  const lines = joined.split('\n');
  const mentioning = lines.filter((l) => /audit-published\.mjs/.test(l));
  const bare = mentioning.filter((l) => !l.trim().startsWith('#') && isBareAuditLine(l));
  if (bare.length === 0) {
    return 'invocation is not a bare own-line `node scripts/audit-published.mjs` (a prefix, `||`, `;`, `&`, subshell, or any argument such as --help)';
  }
  // After the invocation: nothing that swallows the exit status.
  const first = lines.findIndex((l) => bare.includes(l));
  const stmts = splitSourceIntoStatements(lines.slice(first + 1).join('\n')).map((s) =>
    s.text.trim(),
  );
  if (stmts.some((s) => /^(exit\s+0|true|:)$/.test(s))) {
    return 'a later `exit 0` / `true` / `:` swallows the exit status';
  }
  if (/\bset\s+\+e\b/.test(joined)) return 'the script runs under `set +e`';
  return null;
}

// ── workflow reading ───────────────────────────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function needsOf(job: Job): string[] {
  const n = job.needs;
  if (typeof n === 'string') return [n];
  if (Array.isArray(n)) return n.map(String);
  return [];
}

function stepsOf(job: Job): Step[] {
  return Array.isArray(job.steps) ? (job.steps.map(asRecord).filter(Boolean) as Step[]) : [];
}

const runOf = (step: Step): string => (typeof step.run === 'string' ? step.run : '');

/** `continue-on-error` is neutralising unless it is the literal `false`. */
function softensFailure(node: Record<string, unknown>): boolean {
  return 'continue-on-error' in node && node['continue-on-error'] !== false;
}

/** Every string VALUE (not key) in a parsed node. */
function stringValues(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) stringValues(v, out);
  else if (node && typeof node === 'object')
    for (const v of Object.values(node)) stringValues(v, out);
  return out;
}

/** Every string key AND value, for the credential scan. */
function allStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) allStrings(v, out);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.push(k);
      allStrings(v, out);
    }
  }
  return out;
}

function environmentName(job: Job): string {
  const env = job.environment;
  if (typeof env === 'string') return env;
  if (env && typeof env === 'object' && 'name' in env) return String(env.name);
  return '';
}

/** Can this job authenticate to npm? Comment-free (parsed), dot/bracket access, any case. */
function holdsNpmCredential(job: Job): boolean {
  const text = allStrings(job).join('\n');
  const env = environmentName(job);
  return (
    text.includes('NODE_AUTH_TOKEN') ||
    /secrets\s*\.\s*NPM_TOKEN/i.test(text) ||
    /secrets\s*\[\s*['"]NPM_TOKEN['"]\s*\]/i.test(text) ||
    /^npm-publish/.test(env) ||
    env.includes('${{')
  );
}

/**
 * Does this `shell:` keep errexit? A bare `bash` expands to `bash -e{o pipefail} {0}`;
 * a custom template like `bash {0}` does NOT, and a failing audit would no longer
 * stop the step.
 */
const keepsErrexit = (shell: string): boolean =>
  shell.trim() === 'bash' || /^bash\b.*\s-[A-Za-z]*e/.test(shell.trim());

interface JobFacts {
  /** Why this job is a lane candidate, or null. */
  candidate: string | null;
  runsAudit: boolean;
  /** Reason the audit can't gate, when it runs but is neutralised. */
  neutralised: string | null;
  uploadsSbom: boolean;
}

interface Ctx {
  scripts: Record<string, string>;
  repoRoot: string;
  problems: string[];
  where: string;
}

/** Candidate evidence in a step list (a job's, or a composite action's). */
function stepsEvidence(steps: Step[], ctx: Ctx, depth: number): string | null {
  for (const step of steps) {
    const run = runOf(step);
    if (run) {
      const e = runEvidence(run, ctx.scripts);
      if (e) return e;
    }
    for (const v of stringValues(step.env)) {
      if (PUBLISH_WORD.test(v)) return `env value \`${v.trim().slice(0, 60)}\``;
    }
    const uses = typeof step.uses === 'string' ? step.uses : '';
    const withs = asRecord(step.with) ?? {};
    const changesets = /^changesets\/action(@|$)/.test(uses);
    if (changesets) {
      for (const key of ['publish-script', 'publish']) {
        const v = withs[key];
        if (v !== undefined && v !== null && v !== '' && v !== false) {
          return `changesets/action \`${key}\` input`;
        }
      }
    }
    if (PUBLISH_WORD.test(uses)) return `action \`${uses}\``;
    for (const [key, v] of Object.entries(withs)) {
      if (changesets && (key === 'publish' || key === 'publish-script')) continue;
      const hit = stringValues(v).find((s) => PUBLISH_WORD.test(s));
      if (hit) return `\`with.${key}\` value \`${hit.trim().slice(0, 60)}\``;
    }
    if (uses.startsWith('./') && depth < 3) {
      const e = compositeEvidence(uses, ctx, depth + 1);
      if (e) return `composite \`${uses}\` → ${e}`;
    }
  }
  return null;
}

function compositeEvidence(uses: string, ctx: Ctx, depth: number): string | null {
  const dir = resolve(ctx.repoRoot, uses);
  const file = ['action.yml', 'action.yaml'].map((n) => resolve(dir, n)).find((p) => existsSync(p));
  if (!file) {
    ctx.problems.push(
      `${ctx.where}: local action \`${uses}\` has no action.yml/action.yaml to scan`,
    );
    return `unreadable local action \`${uses}\``;
  }
  try {
    const doc = asRecord(parse(readFileSync(file, 'utf8')));
    const steps = asRecord(doc?.runs)?.steps;
    if (!Array.isArray(steps)) return null; // a node/docker action: nothing to scan here
    return stepsEvidence(steps.map(asRecord).filter(Boolean) as Step[], ctx, depth);
  } catch (err) {
    ctx.problems.push(
      `${ctx.where}: local action \`${uses}\` cannot be parsed (${String(err).split('\n')[0]})`,
    );
    return `unparseable local action \`${uses}\``;
  }
}

function analyseJob(job: Job, ctx: Ctx): JobFacts {
  let runsAudit = false;
  let neutralised: string | null = null;
  let uploadsSbom = false;
  const jobSoftened = softensFailure(job);
  const steps = stepsOf(job);

  for (const step of steps) {
    const run = runOf(step);
    if (run && runsAuditScript(run)) {
      runsAudit = true;
      neutralised ??= jobSoftened
        ? 'job has continue-on-error'
        : softensFailure(step)
          ? 'step has continue-on-error'
          : 'if' in step && !/^(true|success\(\))$/.test(String(step.if).replace(/[\s${}]/g, ''))
            ? `step has a conditional \`if: ${step.if}\``
            : step.shell !== undefined && !keepsErrexit(String(step.shell))
              ? `step overrides \`shell: ${step.shell}\``
              : auditInvocationProblem(run);
    }
    const uses = typeof step.uses === 'string' ? step.uses : '';
    const withs = asRecord(step.with) ?? {};
    if (/^actions\/upload-artifact(@|$)/.test(uses) && SBOM_PATH.test(String(withs.path ?? ''))) {
      uploadsSbom = true;
    }
  }

  let candidate = stepsEvidence(steps, ctx, 0);
  if (candidate === null && typeof job.uses === 'string' && PUBLISH_WORD.test(job.uses)) {
    candidate = `reusable workflow \`${job.uses}\``;
  }
  if (candidate === null) {
    const hit = [...stringValues(job.env), ...stringValues(job.with)].find((s) =>
      PUBLISH_WORD.test(s),
    );
    if (hit) candidate = `job env/with value \`${hit.trim().slice(0, 60)}\``;
  }
  if (candidate === null && holdsNpmCredential(job)) {
    candidate =
      'the job holds the npm credential (NODE_AUTH_TOKEN / NPM_TOKEN / npm-publish environment)';
  }
  return { candidate, runsAudit, neutralised, uploadsSbom };
}

/** Transitive `needs` closure; edges out of a status-bypassing job are dropped. */
function closure(
  jobs: Record<string, Job>,
  start: string,
  problems: string[],
  where: string,
): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const job = jobs[id];
    if (!job) continue;
    if (STATUS_BYPASS.test(String(job.if ?? ''))) continue; // starts after a FAILED need
    for (const dep of needsOf(job)) {
      if (!(dep in jobs)) {
        problems.push(
          `${where}: job \`${id}\` needs \`${dep}\`, which is not a job in this workflow`,
        );
        continue;
      }
      if (!seen.has(dep)) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return seen;
}

function readScripts(packageJsonPath: string, problems: string[]): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: unknown };
    const scripts = asRecord(pkg.scripts) ?? {};
    return Object.fromEntries(
      Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch (err) {
    problems.push(`cannot read ${packageJsonPath} to resolve \`<pm> run\` aliases: ${String(err)}`);
    return {};
  }
}

export function auditPublishLanes(options: AuditOptions): PublishLaneAudit {
  const problems: string[] = [];
  const lanes: PublishLane[] = [];
  const excused: string[] = [];
  const auditJobs: string[] = [];
  const sbomJobs: string[] = [];
  const nonLanes = options.nonLanes ?? [];
  const scripts = readScripts(
    options.packageJsonPath ?? resolve(REPO_ROOT, 'package.json'),
    problems,
  );
  const repoRoot = options.repoRoot ?? resolve(options.workflowDir, '..', '..');

  for (const e of nonLanes) {
    if (!e.file || !e.job || !e.reason || e.reason.trim().length < 8) {
      problems.push(`allowlist entry ${JSON.stringify(e)} needs a file, a job and a real reason`);
    }
  }

  let names: string[] = [];
  try {
    names = readdirSync(options.workflowDir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .sort();
  } catch (err) {
    problems.push(`cannot list workflow directory ${options.workflowDir}: ${String(err)}`);
  }

  // Pass 1: read everything. A file we cannot see could hold an ungated lane.
  const parsed: Array<{ file: string; jobs: Record<string, Job> }> = [];
  for (const file of names) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(resolve(options.workflowDir, file), 'utf8'));
    } catch (err) {
      problems.push(`${file}: cannot be read/parsed (${String(err).split('\n')[0]})`);
      continue;
    }
    const jobs = asRecord(asRecord(doc)?.jobs);
    if (jobs === null || Object.keys(jobs).length === 0) {
      problems.push(
        `${file}: parsed but has no \`jobs\` mapping — refusing to read it as "no lanes"`,
      );
      continue;
    }
    const clean: Record<string, Job> = {};
    for (const [id, job] of Object.entries(jobs)) clean[id] = asRecord(job) ?? {};
    parsed.push({ file: basename(file), jobs: clean });
  }

  // Pass 2: per workflow, find gates and candidates, then walk each lane's `needs`.
  const usedAllowlist = new Set<NonLane>();
  for (const { file, jobs } of parsed) {
    const facts = new Map<string, JobFacts>();
    for (const [id, job] of Object.entries(jobs)) {
      facts.set(id, analyseJob(job, { scripts, repoRoot, problems, where: `${file}#${id}` }));
    }

    const audits = new Set<string>();
    const sboms = new Set<string>();
    const neutralisedAudits: string[] = [];
    for (const [id, f] of facts) {
      if (!f.runsAudit) continue;
      if (f.neutralised) {
        neutralisedAudits.push(`\`${id}\` (${f.neutralised})`);
        continue;
      }
      audits.add(id);
      auditJobs.push(`${file}#${id}`);
      if (f.uploadsSbom) {
        sboms.add(id);
        sbomJobs.push(`${file}#${id}`);
      }
    }

    for (const [id, f] of facts) {
      if (f.candidate === null) continue;
      const allowed = nonLanes.find((e) => e.file === file && e.job === id);
      if (allowed) {
        usedAllowlist.add(allowed);
        excused.push(`${file}#${id}`);
        continue;
      }
      lanes.push({ file, jobId: id, why: f.candidate });
      const reach = closure(jobs, id, problems, `${file}#${id}`);
      const label = `${file}#${id} is a publish-lane candidate (${f.candidate})`;
      const hint = neutralisedAudits.length
        ? ` Neutralised audit job(s) here do not count: ${neutralisedAudits.join(', ')}.`
        : '';
      const fix = ' If it is not a lane, name it in the reviewed non-lane allowlist with a reason.';
      if (![...reach].some((j) => audits.has(j))) {
        problems.push(
          `${label} but does not transitively \`needs\` an npm-audit gate (a job running scripts/audit-published.mjs that cannot be skipped or softened).${hint}${fix}`,
        );
      }
      if (![...reach].some((j) => sboms.has(j))) {
        problems.push(
          `${label} but does not transitively \`needs\` an SBOM job (a job running scripts/audit-published.mjs and uploading a *.cdx.json artifact).${hint}${fix}`,
        );
      }
    }
  }

  for (const e of nonLanes) {
    if (!usedAllowlist.has(e)) {
      problems.push(
        `stale allowlist entry ${e.file}#${e.job}: it matches no lane candidate (job removed, or no longer a candidate) — delete it`,
      );
    }
  }

  return { problems, workflowsSeen: names.length, lanes, excused, auditJobs, sbomJobs };
}
