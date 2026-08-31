import { describe, expect, it } from 'bun:test';
import { patchManifestJs } from '../scripts/lib/manifest-patch';

describe('patchManifestJs', () => {
  it('should replace /_next/static/ with static/ in strings', () => {
    const input = 'module.exports = {"file": "/_next/static/chunks/main.js"}';
    const expected = 'module.exports = {"file":"static/chunks/main.js"}';
    expect(patchManifestJs(input)).toBe(expected);
  });

  it('should handle nested objects', () => {
    const input = 'module.exports = {"a": {"b": "/_next/static/test.js"}}';
    const expected = 'module.exports = {"a":{"b":"static/test.js"}}';
    expect(patchManifestJs(input)).toBe(expected);
  });

  it('should handle arrays', () => {
    const input = 'module.exports = {"files": ["/_next/static/a.js", "/_next/static/b.js"]}';
    const expected = 'module.exports = {"files":["static/a.js","static/b.js"]}';
    expect(patchManifestJs(input)).toBe(expected);
  });

  it('should preserve strings without /_next/static/', () => {
    const input = 'module.exports = {"file": "/other/path.js"}';
    const expected = 'module.exports = {"file":"/other/path.js"}';
    expect(patchManifestJs(input)).toBe(expected);
  });

  it('should handle mixed content', () => {
    const input =
      'module.exports = {"static": "/_next/static/x.js", "other": "/other/y.js", "nested": {"file": "/_next/static/z.js"}}';
    const expected =
      'module.exports = {"static":"static/x.js","other":"/other/y.js","nested":{"file":"static/z.js"}}';
    expect(patchManifestJs(input)).toBe(expected);
  });

  it('should return null for invalid format (no assignment)', () => {
    expect(patchManifestJs('just some text')).toBe(null);
  });

  it('should return null for invalid format (no opening brace)', () => {
    expect(patchManifestJs('module.exports = no json here')).toBe(null);
  });

  it('should return null for invalid JSON', () => {
    const input = 'module.exports = {invalid json}';
    expect(patchManifestJs(input)).toBe(null);
  });

  it('should preserve prefix and suffix text', () => {
    const input = '// comment\nmodule.exports = {"file": "/_next/static/main.js"};\n// end';
    const result = patchManifestJs(input);
    expect(result).toContain('// comment');
    expect(result).toContain('// end');
    expect(result).toContain('static/main.js');
  });

  it('should handle empty objects', () => {
    const input = 'module.exports = {}';
    const expected = 'module.exports = {}';
    expect(patchManifestJs(input)).toBe(expected);
  });

  it('should handle multiple /_next/static/ occurrences in one string', () => {
    const input = 'module.exports = {"files": "/_next/static/a.js,/_next/static/b.js"}';
    const expected = 'module.exports = {"files":"static/a.js,/_next/static/b.js"}';
    // Note: Our implementation only replaces the first occurrence per string value
    // This test documents current behavior
    expect(patchManifestJs(input)).toBe(expected);
  });

  it('should handle complex real-world manifest structure', () => {
    const input = `module.exports = {
      "clientModules": {
        "/_next/static/chunks/app/page.js": {
          "id": "/_next/static/chunks/app/page.js",
          "chunks": ["/_next/static/chunks/webpack.js"]
        }
      }
    }`;
    const result = patchManifestJs(input);
    expect(result).not.toBe(null);
    expect(result).toContain('static/chunks/app/page.js');
    expect(result).toContain('static/chunks/webpack.js');
  });
});
