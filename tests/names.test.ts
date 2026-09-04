import { describe, expect, it } from 'bun:test';
import { toDns1123Label } from '../scripts/lib/names';

describe('toDns1123Label', () => {
  it('should convert uppercase to lowercase', () => {
    expect(toDns1123Label('MyPage')).toBe('mypage');
  });

  it('should replace invalid characters with hyphens', () => {
    expect(toDns1123Label('my_page')).toBe('my-page');
    expect(toDns1123Label('my.page')).toBe('my-page');
    expect(toDns1123Label('my page')).toBe('my-page');
    expect(toDns1123Label('my@page#test')).toBe('my-page-test');
  });

  it('should trim leading and trailing hyphens', () => {
    expect(toDns1123Label('-mypage-')).toBe('mypage');
    expect(toDns1123Label('--mypage--')).toBe('mypage');
  });

  it('should handle multiple consecutive invalid characters', () => {
    expect(toDns1123Label('my___page')).toBe('my-page');
    expect(toDns1123Label('my...page')).toBe('my-page');
  });

  it('should truncate to 63 characters', () => {
    const longName = 'a'.repeat(100);
    expect(toDns1123Label(longName)).toBe('a'.repeat(63));
  });

  it('should return "default" for empty or all-invalid input', () => {
    expect(toDns1123Label('')).toBe('default');
    expect(toDns1123Label('___')).toBe('default');
    expect(toDns1123Label('...')).toBe('default');
  });

  it('should preserve valid alphanumeric and hyphens', () => {
    expect(toDns1123Label('my-page-123')).toBe('my-page-123');
    expect(toDns1123Label('page123')).toBe('page123');
  });

  it('should handle mixed case and special characters', () => {
    expect(toDns1123Label('My_Page-123.Test')).toBe('my-page-123-test');
  });

  it('should handle edge cases', () => {
    expect(toDns1123Label('index')).toBe('index');
    expect(toDns1123Label('/')).toBe('default');
    expect(toDns1123Label('a/b/c')).toBe('a-b-c');
  });
});
