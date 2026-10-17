import { describe, expect, it } from 'bun:test';
import { InvalidFileNameError, objectKeyFor, validateFileName } from './object-key';

describe('validateFileName', () => {
  it('accepts ordinary names, including spaces and unicode', () => {
    expect(validateFileName('report.pdf')).toBe('report.pdf');
    expect(validateFileName('my photo (1).jpg')).toBe('my photo (1).jpg');
    expect(validateFileName('résumé-日本語.txt')).toBe('résumé-日本語.txt');
    expect(validateFileName('a..b.txt')).toBe('a..b.txt');
  });

  it.each([
    '../etc/passwd',
    '..\\windows\\system32',
    'a/b.txt',
    'a\\b.txt',
    '/abs.txt',
    '..',
    '.',
    '   ',
    '',
    'nul\0byte.txt',
    'new\nline.txt',
    'x'.repeat(256),
  ])('refuses %j', (name) => {
    expect(() => validateFileName(name)).toThrow(InvalidFileNameError);
  });

  it('refuses a non-string (a form field that is not a name)', () => {
    expect(() => validateFileName(undefined)).toThrow(InvalidFileNameError);
    expect(() => validateFileName(42)).toThrow(InvalidFileNameError);
  });
});

describe('objectKeyFor', () => {
  it('prefixes a generated id, so the same name never maps to the same key', () => {
    const a = objectKeyFor('photo.jpg');
    const b = objectKeyFor('photo.jpg');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}-photo\.jpg$/);
  });

  it('never contains a path separator', () => {
    expect(objectKeyFor('x.txt')).not.toMatch(/[\\/]/);
  });
});
