/**
 * A small, real evaluator for the GitHub Actions expression subset the compat
 * workflow's lane/builder/mode selectors use — so a guard EVALUATES the
 * expression against event contexts instead of grepping its text (#1245).
 *
 * Supported: string literals ('…', with '' escapes), `true`/`false`/`null`,
 * property paths (`github.event.schedule`, `env.KNEXT_BUILDER`), the operators
 * `==` `!=` `&&` `||` `!`, parentheses, and the `format()` function. Anything
 * else THROWS — an expression shape this evaluator does not understand must
 * fail the guard, never evaluate to something plausible.
 *
 * Semantics follow the Actions docs: `&&`/`||` return an operand (not a
 * boolean), `==` on strings is case-insensitive, a missing property is `null`,
 * and the falsy values are `null`, `false`, `0` and `''`.
 */

type Value = string | boolean | number | null;
type Ctx = Record<string, unknown>;

type Tok =
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'num'; v: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new Error(`unterminated string literal in: ${src}`);
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('()!,'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    const num = src.slice(i).match(/^\d+(\.\d+)?/);
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*/);
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new Error(`unsupported character '${ch}' at ${i} in: ${src}`);
  }
  return out;
}

export function truthy(v: Value): boolean {
  return !(v === null || v === false || v === 0 || v === '');
}

function asString(v: Value): string {
  if (v === null) return '';
  return String(v);
}

function lookup(path: string, ctx: Ctx): Value {
  if (path === 'true') return true;
  if (path === 'false') return false;
  if (path === 'null') return null;
  let cur: unknown = ctx;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) return null;
  }
  if (cur === null || ['string', 'boolean', 'number'].includes(typeof cur)) return cur as Value;
  throw new Error(`property ${path} is not a scalar`);
}

function eq(a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function evaluate(expr: string, ctx: Ctx): Value {
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()?.v === v;
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new Error(`expected '${v}' at token ${p} in: ${expr}`);
    p++;
  };

  function primary(): Value {
    const tok = peek();
    if (!tok) throw new Error(`unexpected end of expression: ${expr}`);
    if (tok.t === 'op' && tok.v === '(') {
      p++;
      const v = or();
      expectOp(')');
      return v;
    }
    if (tok.t === 'op' && tok.v === '!') {
      p++;
      return !truthy(primary());
    }
    if (tok.t === 'str') {
      p++;
      return tok.v;
    }
    if (tok.t === 'num') {
      p++;
      return tok.v;
    }
    if (tok.t === 'id') {
      p++;
      if (isOp('(')) {
        p++;
        const args: Value[] = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) {
            p++;
            args.push(or());
          }
        }
        expectOp(')');
        if (tok.v !== 'format') throw new Error(`unsupported function ${tok.v}() in: ${expr}`);
        const fmt = asString(args[0] ?? null);
        return fmt.replace(/\{(\d+)\}/g, (_, n) => asString(args[Number(n) + 1] ?? null));
      }
      return lookup(tok.v, ctx);
    }
    throw new Error(`unexpected token '${tok.v}' in: ${expr}`);
  }

  function comparison(): Value {
    let left = primary();
    while (isOp('==') || isOp('!=')) {
      const op = (peek() as Tok).v;
      p++;
      const right = primary();
      left = op === '==' ? eq(left, right) : !eq(left, right);
    }
    return left;
  }

  function and(): Value {
    let left = comparison();
    while (isOp('&&')) {
      p++;
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  function or(): Value {
    let left = and();
    while (isOp('||')) {
      p++;
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  const v = or();
  if (p !== toks.length) throw new Error(`trailing tokens after position ${p} in: ${expr}`);
  return v;
}

/** Strip the `${{ … }}` wrapper from a workflow value, throwing if absent. */
export function exprBody(value: unknown): string {
  const m = String(value ?? '').match(/^\s*\$\{\{\s*([\s\S]*?)\s*\}\}\s*$/);
  if (!m) throw new Error(`not a \${{ }} expression: ${String(value)}`);
  return m[1];
}
