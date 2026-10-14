/**
 * The in-process Rust page (rust-in-process.mdx) and the `knext ffi` section
 * of the CLI reference quote error messages, file names, defaults and install
 * commands a user acts on. Each quote is compared against the string the code
 * itself produces, never against a copy kept in this file:
 *
 * - the generated module's runtime messages (Node refusal, prerender refusal,
 *   integrity refusal, development-build notice, argument TypeError, the
 *   `invalid input:` prefix) are read out of a module rendered by
 *   `renderModule`, and each must match a whole code block (the TypeError, a
 *   whole inline code span) with only the interpolated values left free;
 * - the build-time refusals (`FFI_NODE_REFUSAL`, `FFI_SELF_CONTAINED_REFUSAL`)
 *   must each equal a whole code block, every line of it;
 * - the reserved-name error is the message `scanManifest` throws for a
 *   function named `process`, and the reserved name lists are the generator's
 *   own `RESERVED` and `RESERVED_TYPES` sets;
 * - the toolchain install commands are `INSTALL_HINTS`, the strings the
 *   build's toolchain check prints;
 * - the Rust messages (the `char` compile error, the "could not be decoded"
 *   input error) are the string literals in the crates' source, and the
 *   compile error is cross-checked against the compiler output its trybuild
 *   case pins.
 *
 * Measurements (per-call costs, the hardware they were taken on) and prose
 * claims have no code behind them, so they are checked for presence and
 * wording only.
 *
 * The general rules (no ADR/issue/PR references, no unpublished-package
 * hedging) are content-hygiene.test.ts's; this file checks this page's
 * load-bearing content.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { blob, D, fn } from '../../packages/ffi/src/__tests__/helpers';
import { INSTALL_HINTS, SUPPORTED_TARGETS } from '../../packages/ffi/src/build';
import { BETA_NOTICE } from '../../packages/ffi/src/cli';
import { DEFAULT_CONFIG, serializeConfig } from '../../packages/ffi/src/config';
import { RESERVED, RESERVED_TYPES, scanManifest } from '../../packages/ffi/src/manifest';
import { renderModule } from '../../packages/ffi/src/render';
import {
  FFI_NODE_REFUSAL,
  FFI_SELF_CONTAINED_REFUSAL,
} from '../../packages/kn-next/src/cli/ffi-preflight';

const REPO = resolve(import.meta.dirname, '../..');
const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const page = readFileSync(join(DOCS_DIR, 'rust-in-process.mdx'), 'utf-8');
const cli = readFileSync(join(DOCS_DIR, 'cli.mdx'), 'utf-8');
const meta = JSON.parse(readFileSync(join(DOCS_DIR, 'meta.json'), 'utf-8')) as {
  pages: string[];
};
const repoFile = (rel: string) => readFileSync(join(REPO, rel), 'utf-8');

/** The body of the `## ` section whose heading matches, up to the next `## `. */
function section(text: string, heading: RegExp): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && heading.test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** A section that must exist: an empty body would let every assertion below pass vacuously. */
function must(text: string, heading: RegExp): string {
  const body = section(text, heading);
  expect(body.trim().length, `no "## " section matching ${heading}`).toBeGreaterThan(200);
  return body;
}

/** Every fenced code block in `text`, dedented by its fence's own indentation. */
function codeBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^( *)```/.exec(lines[i] as string);
    if (!open) continue;
    const indent = open[1] as string;
    const body: string[] = [];
    for (i++; i < lines.length && !(lines[i] as string).startsWith(`${indent}\`\`\``); i++) {
      const line = lines[i] as string;
      body.push(line.startsWith(indent) ? line.slice(indent.length) : line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

/** Every inline code span in `text`. */
const inlineCode = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A literal run of a message, or `null` for an interpolated value. */
type Part = string | null;

/** One interpolated value: anything on one line. */
const VALUE = '[^\\n]+?';

/** A regex source for the message, each interpolation free (or the matching `fills` entry). */
function pattern(parts: readonly Part[], fills: readonly string[] = []): string {
  let hole = 0;
  return parts.map((p) => (p === null ? (fills[hole++] ?? VALUE) : escapeRe(p))).join('');
}

/** Exactly one match of `re` in `text`; the regex must not carry flags of its own. */
function only(text: string, re: RegExp, where: string): RegExpExecArray {
  const hits = [...text.matchAll(new RegExp(re.source, 'g'))];
  expect(hits.length, `${re} must match ${where} exactly once`).toBe(1);
  return hits[0] as RegExpExecArray;
}

/**
 * The template literal in `source` that opens where `anchor` ends (the anchor
 * ends with the opening backtick), split into literal runs and interpolations.
 */
function templateAfter(source: string, anchor: RegExp): Part[] {
  const hit = only(source, anchor, 'the rendered module');
  let i = hit.index + hit[0].length;
  const parts: Part[] = [];
  let lit = '';
  for (;;) {
    const c = source[i];
    if (c === undefined) throw new Error(`unterminated template after ${anchor}`);
    if (c === '`') break;
    if (c === '\\') {
      const next = source[i + 1] as string;
      lit += next === 'n' ? '\n' : next;
      i += 2;
    } else if (c === '$' && source[i + 1] === '{') {
      let depth = 1;
      for (i += 2; depth > 0; i++) {
        if (source[i] === undefined) throw new Error(`unterminated \${…} after ${anchor}`);
        if (source[i] === '{') depth++;
        if (source[i] === '}') depth--;
      }
      parts.push(lit, null);
      lit = '';
    } else {
      lit += c;
      i++;
    }
  }
  parts.push(lit);
  return parts;
}

/** The Rust string literal in the crate file `rel` that opens where `before` ends. */
function rustLiteral(rel: string, before: RegExp): string {
  const hit = only(repoFile(rel), new RegExp(`${before.source}"((?:[^"\\\\]|\\\\.)*)"`), rel);
  return (hit[1] as string).replace(/\\(.)/g, '$1');
}

/** A Rust format string split into literal runs and `{…}` arguments. */
function rustFormat(fmt: string): Part[] {
  return fmt.split(/(\{[a-z_]*\})/).map((p) => (/^\{[a-z_]*\}$/.test(p) ? null : p));
}

/** The message `f` throws. */
function thrown(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

/** Some code block of `body` is exactly the message `source` describes. */
function expectBlock(body: string, source: string, what: string): void {
  const re = new RegExp(`^${source}$`);
  expect(
    codeBlocks(body).some((b) => re.test(b)),
    `${what}: no code block is exactly ${re}`,
  ).toBe(true);
}

/** A module rendered for one `greet(&str) -> String` export: every message below comes from it. */
const rendered = renderModule(
  {
    fns: [
      {
        name: 'greet',
        symbol: 'knext_ffi_v1_greet_00000000',
        sig: 'greet(string)->string',
        doc: '',
        args: [{ name: 'name', type: { t: 'string' }, rust: '&str' }],
        ret: { type: { t: 'string' }, rust: 'String' },
        err: null,
      },
    ],
    records: [],
    enums: [],
  },
  { libName: 'zone', crate: 'rust' },
);

/** The literal a rendered module carries for `$PRERENDER` (the build-time refusal). */
function prerenderMessage(): string {
  const literal = /^const \$PRERENDER = '(.*)';$/m.exec(rendered)?.[1];
  expect(literal, 'the rendered module no longer declares $PRERENDER').toBeDefined();
  return (literal as string).replace(/\\'/g, "'");
}

describe('docs — in-process Rust page', () => {
  it('is in the sidebar', () => {
    expect(meta.pages).toContain('rust-in-process');
  });

  it('opens with the Beta callout, naming every reason it is Beta', () => {
    const callout = /<Callout[^>]*>([\s\S]*?)<\/Callout>/.exec(page)?.[1] ?? '';
    expect(page.indexOf('<Callout')).toBeLessThan(page.indexOf('\n## '));
    expect(callout).toContain('Beta, and not published yet');
    expect(callout).toMatch(/Bun only|only on Bun/i);
    expect(callout).toMatch(/experimental/i);
    expect(callout).toMatch(/compatibility credential/i);
    expect(callout).toContain('@getknext/ffi');
    expect(callout).toMatch(/not on npm/i);
    expect(callout).toMatch(/git commit/i);
  });

  it('quotes the build-time prerendering refusal exactly, with both fixes', () => {
    const body = must(page, /dynamic contexts only/i);
    expectBlock(body, escapeRe(`Error [FfiLoadError]: ${prerenderMessage()}`), 'prerender');
    expect(body).toContain("export const dynamic = 'force-dynamic'");
    expect(body).toContain('await connection()');
    expect(body).toMatch(/generateStaticParams/);
    expect(body).toMatch(/generateMetadata/);
  });

  it('quotes the build-time Node refusal whole, and the runtime one as the module throws it', () => {
    const body = must(page, /node/i);
    expect(codeBlocks(body)).toContain(FFI_NODE_REFUSAL);
    const runtime = templateAfter(
      rendered,
      /if \(!process\.versions\['bun'\]\) \{\s*throw new FfiLoadError\(\s*`/,
    );
    expectBlock(body, `FfiLoadError: ${pattern(runtime)}`, 'the runtime Node refusal');
  });

  it('quotes the self-contained refusal whole', () => {
    const body = must(page, /self-contained/i);
    expect(codeBlocks(body)).toContain(FFI_SELF_CONTAINED_REFUSAL);
  });

  it('quotes the integrity refusal and the development-build notice as the module prints them', () => {
    const body = must(page, /where the library is loaded from/i);
    const mismatch = templateAfter(
      rendered,
      /\$createHash\('sha256'\)[^\n]*\n\s*if \(actual !== expected\) \{\s*throw new FfiLoadError\(\s*`/,
    );
    expectBlock(body, pattern(mismatch), 'the sha256 mismatch refusal');
    const notice = templateAfter(rendered, /console\.warn\(\s*`/);
    expectBlock(must(page, /quick start/i), pattern(notice), 'the development-build notice');
  });

  it('quotes the argument TypeError as the module throws it', () => {
    const body = must(page, /errors and panics/i);
    const typeError = new RegExp(
      `^${pattern(templateAfter(rendered, /function \$str\([^)]*\)[^{]*\{[^`]*`/))}$`,
    );
    expect(
      inlineCode(body).some((span) => typeError.test(span)),
      `no inline code span is exactly ${typeError}`,
    ).toBe(true);
  });

  it('quotes the "invalid input" error as the module and the crate build it', () => {
    const body = must(page, /records and enums/i);
    const prefix = templateAfter(rendered, /status === 3 \? `/);
    const decode = rustFormat(
      rustLiteral(
        'crates/knext-ffi/src/lib.rs',
        /pub unsafe fn json_arg[\s\S]*?Invalid\(format!\(\s*/,
      ),
    );
    expectBlock(body, pattern(prefix, [pattern(decode)]), 'the invalid-input error');
  });

  it('quotes the `char` compile error as the macro words it and the compiler prints it', () => {
    const body = must(page, /type mapping/i);
    const types = 'crates/knext-ffi-macros/src/types.rs';
    const fmt = rustLiteral(
      types,
      /pub fn reject\([^)]*\)[^{]*\{\s*Error::new\(\s*span\.span\(\),\s*format!\(\s*/,
    );
    const why = rustLiteral(types, /"char" => \{\s*return Err\(reject\(\s*ty,\s*ty,\s*/);
    expect(fmt.split('{TABLE_HINT}')).toHaveLength(2);
    const [head] = fmt.split('{TABLE_HINT}') as [string];
    // The docs stop where the hint pointing at the crate's README begins.
    const quoted = `error: ${head.replace('{}', 'char').replace('{why}', why)}`;
    expect(codeBlocks(body)).toContain(`${quoted}…`);
    const compiler = repoFile('crates/knext-ffi/tests/ui/fail/char_arg.stderr').split('\n')[0];
    expect(compiler?.startsWith(quoted), `char_arg.stderr: ${compiler}`).toBe(true);
  });

  it('lists every global and declared name a Rust function or argument may not take', () => {
    const body = must(page, /reserved names/i);
    // Every name the module declares or references that is not a language
    // keyword: the capitalised ones, plus the two lowercase globals.
    const globals = [...RESERVED].filter(
      (n) => /^[A-Z]/.test(n) || n === 'process' || n === 'console',
    );
    expect(globals.length).toBeGreaterThan(10);
    for (const name of globals) expect(body, name).toContain(`\`${name}\``);
    for (const name of RESERVED_TYPES) expect(body, name).toContain(`\`${name}\``);
    expect(body).toContain('__proto__');
    expect(body).toMatch(/rename it in Rust/);
  });

  it('quotes the reserved-name error exactly as the generator throws it', () => {
    const body = must(page, /reserved names/i);
    const message = thrown(() => scanManifest(blob([fn('process', [], D.t('string'))])));
    expect(codeBlocks(body)).toContain(message);
  });

  it('shows knext.ffi.json exactly as `knext ffi init` writes it', () => {
    expect(page).toContain(serializeConfig(DEFAULT_CONFIG).trim());
  });

  it('names the image targets and the toolchain install commands the build prints', () => {
    const body = must(page, /building images/i);
    for (const t of SUPPORTED_TARGETS) expect(body).toContain(t);
    const blocks = codeBlocks(body);
    expect(blocks).toContain(INSTALL_HINTS.zigbuild);
    expect(blocks).toContain(`${INSTALL_HINTS.rustupTarget} ${SUPPORTED_TARGETS[0]}`);
    expect(body).toContain(`(${INSTALL_HINTS.zigUrl})`);
    expect(body).toContain(`\`${INSTALL_HINTS.zigPip}\``);
    expect(body).toMatch(/Cargo\.lock/);
  });

  it('says what happens to a non-finite float in each JSON position', () => {
    const body = must(page, /type mapping/i);
    expect(body).not.toMatch(/must be finite/i);
    // A plain float argument or return crosses as a raw number.
    expect(body).toMatch(/`NaN`\s+and\s+`Infinity`\s+arrive\s+intact/);
    // An Option position turns it into None/null without an error.
    expect(body).toMatch(/silently becomes `None`[^.]*`null`/);
    // Everywhere else in JSON it is refused, both ways.
    expect(body).toMatch(/anywhere else[^.]*refused/i);
  });

  it('states every per-call number with the hardware and Bun version it was measured on', () => {
    const body = must(page, /blocking/i);
    expect(body).toMatch(/\bns\b/);
    expect(body).toContain('M1 Pro');
    expect(body).toContain('Bun 1.4.2');
  });

  it('says the numbers come from a prototype, with the row labels that were measured', () => {
    const body = must(page, /blocking/i);
    expect(body).toContain('a prototype of the generated wrapper');
    expect(body).toContain('`sum(Vec<u8>)`');
    expect(body).not.toContain('sum(&[u8])');
  });

  it('says Workers share one copy of the library, and with it every Rust static', () => {
    const body = must(page, /blocking/i);
    expect(body).not.toMatch(/its own copy of the library/);
    expect(body).toMatch(/one copy of the library/);
    expect(body).toContain('OnceLock');
    expect(body).toMatch(/shared/);
  });

  it('is honest that Workers inside a Next.js build do not work, and points at zone functions', () => {
    const body = must(page, /blocking/i);
    expect(body).toMatch(/Turbopack/);
    expect(body).toMatch(/webpack/);
    expect(body).toMatch(/zone function/i);
    expect(body).toContain('--conditions=react-server');
  });

  it('marks the supply-chain checks that are planned rather than shipped', () => {
    const body = must(page, /supply chain/i);
    expect(body).toMatch(/planned/i);
    expect(body).toContain('provenance.json');
    expect(body).toContain('.integrity.json');
  });
});

describe('docs — the `knext ffi` CLI reference', () => {
  const body = section(cli, /^## `knext ffi`$/);

  it('has the section, with every subcommand and exit codes', () => {
    expect(body.trim().length).toBeGreaterThan(200);
    for (const sub of ['init', 'generate', 'check', 'build']) {
      expect(body).toContain(`knext ffi ${sub}`);
    }
    expect(body).toContain('Exit code');
    expect(body).toContain('--target');
    expect(body).toContain('--native-dir');
  });

  it('quotes the Beta line every run prints', () => {
    expect(body).toContain(BETA_NOTICE);
  });

  it('links the full page', () => {
    expect(body).toContain('/docs/rust-in-process');
  });
});
