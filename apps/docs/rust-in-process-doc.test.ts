/**
 * The in-process Rust page (rust-in-process.mdx) and the `knext ffi` section
 * of the CLI reference quote error messages, file names, defaults and refusals
 * a user acts on. Every one of them is pinned here against the code that
 * produces it, not against a copy, so the page cannot drift from the feature:
 * the generator (`packages/ffi`), the core preflight
 * (`packages/kn-next/src/cli/ffi-preflight.ts`) and the rendered module.
 *
 * The general rules (no ADR/issue/PR references, no unpublished-package
 * hedging) are content-hygiene.test.ts's; this file checks this page's
 * load-bearing content.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SUPPORTED_TARGETS } from '../../packages/ffi/src/build';
import { BETA_NOTICE } from '../../packages/ffi/src/cli';
import { DEFAULT_CONFIG, serializeConfig } from '../../packages/ffi/src/config';
import { RESERVED, RESERVED_TYPES } from '../../packages/ffi/src/manifest';
import { renderModule } from '../../packages/ffi/src/render';
import {
  FFI_NODE_REFUSAL,
  FFI_SELF_CONTAINED_REFUSAL,
} from '../../packages/kn-next/src/cli/ffi-preflight';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const page = readFileSync(join(DOCS_DIR, 'rust-in-process.mdx'), 'utf-8');
const cli = readFileSync(join(DOCS_DIR, 'cli.mdx'), 'utf-8');
const meta = JSON.parse(readFileSync(join(DOCS_DIR, 'meta.json'), 'utf-8')) as {
  pages: string[];
};

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

/** The literal a rendered module carries for `$PRERENDER` (the build-time refusal). */
function prerenderMessage(): string {
  const module = renderModule(
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
  const literal = /^const \$PRERENDER = '(.*)';$/m.exec(module)?.[1];
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
    expect(body).toContain(prerenderMessage());
    expect(body).toContain("export const dynamic = 'force-dynamic'");
    expect(body).toContain('await connection()');
    expect(body).toMatch(/generateStaticParams/);
    expect(body).toMatch(/generateMetadata/);
  });

  it('quotes the Node refusals (build and runtime) and the self-contained refusal', () => {
    const body = must(page, /node/i);
    expect(body).toContain(FFI_NODE_REFUSAL.split('\n')[0] as string);
    expect(body).toContain('In-process Rust (bun:ffi) runs only on Bun; this process is Node');
    const sc = must(page, /self-contained/i);
    expect(sc).toContain(FFI_SELF_CONTAINED_REFUSAL.split('\n')[0] as string);
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
    for (const name of [
      'any',
      'bigint',
      'boolean',
      'never',
      'number',
      'object',
      'string',
      'symbol',
      'unknown',
    ]) {
      expect(RESERVED_TYPES.has(name), name).toBe(true);
      expect(body, name).toContain(`\`${name}\``);
    }
    expect(body).toContain('__proto__');
    expect(body).toMatch(/rename it in Rust/);
  });

  it('shows knext.ffi.json exactly as `knext ffi init` writes it', () => {
    expect(page).toContain(serializeConfig(DEFAULT_CONFIG).trim());
  });

  it('names the image targets and the toolchain install commands the build asks for', () => {
    const body = must(page, /building images/i);
    for (const t of SUPPORTED_TARGETS) expect(body).toContain(t);
    expect(body).toContain('cargo install --locked cargo-zigbuild');
    expect(body).toContain('rustup target add x86_64-unknown-linux-musl');
    expect(body).toMatch(/ziglang\.org/);
    expect(body).toMatch(/Cargo\.lock/);
  });

  it('states every per-call number with the hardware and Bun version it was measured on', () => {
    const body = must(page, /blocking/i);
    expect(body).toMatch(/\bns\b/);
    expect(body).toContain('M1 Pro');
    expect(body).toContain('Bun 1.4.2');
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
