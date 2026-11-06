/**
 * Comment stripping for JS/TS source that is READ, never executed: the
 * `doctor` use-cache check and the tracing-root config reader both need to
 * ignore commented-out code without mistaking comment-like text inside a
 * string (a glob such as `'/img/**'`, a URL) for a comment.
 */

/**
 * Remove // and block comments from source while leaving string and
 * template-literal contents untouched, so `'/api/*'` does not open a
 * "comment" that swallows the code after it. Block comments keep their
 * newlines, so the line structure the directive regex relies on survives.
 */
export function stripCodeComments(src: string): string {
    let out = "";
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '"' || c === "'" || c === "`") {
            const start = i;
            i++;
            while (i < n && src[i] !== c) {
                if (src[i] === "\\") i++;
                else if (c !== "`" && src[i] === "\n") break;
                i++;
            }
            i++;
            out += src.slice(start, i);
            continue;
        }
        if (c === "/" && src[i + 1] === "/") {
            while (i < n && src[i] !== "\n") i++;
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            const end = src.indexOf("*/", i + 2);
            const stop = end === -1 ? n : end + 2;
            out += src.slice(i, stop).replace(/[^\n]/g, "");
            i = stop;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
