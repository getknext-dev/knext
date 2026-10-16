/**
 * `exportsAuthorize`: the lexical check `knext generate` runs on the module
 * `"authorize"` names, so a zone that does not provide the authorize() hook is
 * refused at generate time, not discovered by a failing build. It must accept
 * every way of exporting `authorize` by name and refuse everything else,
 * including what only LOOKS like an export (a comment, a string, a type).
 */

import { describe, expect, it } from 'bun:test';
import { exportsAuthorize } from '../config';

describe('exportsAuthorize — accepted', () => {
  for (const [name, source] of [
    ['async function', 'export async function authorize(ctx) {}'],
    ['function', 'export function authorize(ctx) {}'],
    ['generic function', 'export async function authorize<T>(ctx: T) {}'],
    ['const', 'export const authorize = async () => ({ sub: "a" });'],
    ['typed const', 'export const authorize: Authorize = async () => ({ sub: "a" });'],
    ['let', 'export let authorize = () => ({ sub: "a" });'],
    ['list', 'function a() {}\nexport { a as authorize };'],
    ['list, no spaces', 'function authorize() {}\nexport{authorize}'],
    ['list among others', 'export { x, authorize, y as z };'],
    ['re-export', 'export { authorize } from "./session";'],
    ['renamed re-export', 'export { check as authorize } from "./session";'],
    ['default re-exported by name', 'export { default as authorize } from "./session";'],
    ['after a URL', 'const u = "https://example.com"; export function authorize() {}'],
    ['after a string holding //', "const s = '//'; export function authorize() {}"],
  ] as const) {
    it(name, () => {
      expect(exportsAuthorize(source)).toBe(true);
    });
  }
});

describe('exportsAuthorize — refused', () => {
  for (const [name, source] of [
    ['empty', ''],
    ['line comment', '// export async function authorize(ctx) {}'],
    ['block comment', '/* export async function authorize(ctx) {} */'],
    ['trailing comment', 'const a = 1; // export function authorize() {}'],
    ['default export', 'export default async function authorize() {}'],
    ['star re-export', 'export * from "./session";'],
    ['not exported', 'async function authorize() {}'],
    ['other name', 'export function authorise() {}'],
    ['prefix only', 'export function authorizeUser() {}'],
    ['exported as something else', 'function authorize() {}\nexport { authorize as check };'],
    ['type-only list', 'type authorize = 1;\nexport type { authorize };'],
    ['type-only specifier', 'type authorize = 1;\nexport { type authorize };'],
    ['type alias', 'export type authorize = () => void;'],
    ['interface', 'export interface authorize {}'],
  ] as const) {
    it(name, () => {
      expect(exportsAuthorize(source)).toBe(false);
    });
  }
});
