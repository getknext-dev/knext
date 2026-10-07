/**
 * The consumer analysis behind the compiled executable's asset-anchor rewrite
 * (see entry-asset-anchor.mjs for the whole mechanism): parse a bundled
 * package module with acorn and report, for every
 * `new URL(<relative literal>, import.meta.url)`, what the URL FEEDS —
 *
 *   - `"read"` — the URL (directly, through `fileURLToPath(...)`/`.pathname`,
 *     or through up to `MAX_BINDING_HOPS` `const`/`let`/`var` bindings) is the
 *     first argument of `readFileSync`/`readFile` (incl. `fs.promises.readFile`
 *     and CJS-interop `(0, x.readFileSync)` callees), or of ANY call whose
 *     result is compiled as WebAssembly (`new WebAssembly.Module(f(url))`,
 *     `WebAssembly.compile|instantiate(f(url))` — the minified-alias shape
 *     vinext's own HarfBuzz loader takes). The only kind that is rewritten.
 *   - `"excluded"` — `new Worker`/`new SharedWorker` (incl. `worker_threads`),
 *     `fetch(...)`, `require(...)`, or a dynamic `import(...)`. A binding that
 *     reaches one of these is excluded even if it ALSO reaches a read.
 *   - `"unknown"` — anything else. Left alone: nothing here guesses.
 *
 * Comments and string literals are not code, so the parser never reports an
 * anchor inside them — no hand-rolled lexer.
 *
 * ## Why a separate process
 *
 * `vinext-compile.mjs` runs this as its OWN `bun` process (script mode below:
 * module source on stdin, JSON on stdout) rather than importing it. The
 * compile script's static import closure must stay node-builtins-only — it
 * holds the Bun base-executable seal (bun-base-exe.mjs), and
 * `bun-base-exe-seam.test.ts` scans every module in that closure for
 * global/prototype writes, which a third-party package would bypass. A
 * process boundary keeps acorn out of the compile realm entirely. The cost is
 * one short `bun` spawn per module whose TEXT matches the anchor prefilter — a
 * handful per build.
 *
 * Retirement condition: a released Bun that embeds such sibling files itself
 * (oven-sh/bun#44695).
 */

import { parse } from "acorn";
import { hasAssetAnchorCandidate } from "./entry-asset-anchor.mjs";

/** How many variable bindings an anchor may flow through before its read. */
const MAX_BINDING_HOPS = 3;
/** Callees whose first argument is a file READ. */
const READ_CALLEES = new Set(["readFileSync", "readFile"]);
/** Callees that only convert the URL to a path — look through them. */
const PATH_CALLEES = new Set(["fileURLToPath"]);
/** Call consumers that LOAD or fetch something rather than read bytes. */
const EXCLUDED_CALLEES = new Set(["fetch", "require"]);
/** Constructors that load the URL as CODE. */
const WORKER_CTORS = new Set(["Worker", "SharedWorker"]);
/** `URL` members that still name the same file — look through them. */
const URL_PATH_MEMBERS = new Set(["href", "pathname"]);
/** `WebAssembly.<fn>(bytes)` call sinks: their argument IS file bytes. */
const WASM_CALL_SINKS = new Set(["compile", "instantiate"]);

const READ = "read";
const EXCLUDED = "excluded";
const UNKNOWN = "unknown";

/** The name a callee is called by: `f`, `x.f`, `x["f"]`, `(0, x.f)`, `x?.f`. */
function calleeName(callee) {
    if (callee.type === "Identifier") return callee.name;
    if (callee.type === "MemberExpression") {
        if (!callee.computed && callee.property.type === "Identifier") return callee.property.name;
        if (callee.computed && callee.property.type === "Literal")
            return String(callee.property.value);
        return undefined;
    }
    if (callee.type === "SequenceExpression") {
        return calleeName(callee.expressions[callee.expressions.length - 1]);
    }
    if (callee.type === "ChainExpression") return calleeName(callee.expression);
    return undefined;
}

/** `WebAssembly.<name>` (non-computed) — `name` checked by the caller. */
function webAssemblyMember(callee) {
    return callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        callee.object.name === "WebAssembly" &&
        callee.property.type === "Identifier"
        ? callee.property.name
        : undefined;
}

/** Whether `call`'s result is the first argument of a WebAssembly compile. */
function feedsWebAssembly(call, parents) {
    const p = parents.get(call);
    if (p === undefined || p.arguments?.[0] !== call) return false;
    const member = webAssemblyMember(p.callee);
    if (p.type === "NewExpression") return member === "Module";
    if (p.type === "CallExpression") return WASM_CALL_SINKS.has(member);
    return false;
}

/** The literal of `new URL(<relative literal>, import.meta.url)`, or undefined. */
function anchorLiteral(node) {
    if (node.callee.type !== "Identifier" || node.callee.name !== "URL") return undefined;
    if (node.arguments.length !== 2) return undefined;
    const [spec, base] = node.arguments;
    const isImportMetaUrl =
        base.type === "MemberExpression" &&
        !base.computed &&
        base.object.type === "MetaProperty" &&
        base.object.meta.name === "import" &&
        base.object.property.name === "meta" &&
        base.property.type === "Identifier" &&
        base.property.name === "url";
    if (!isImportMetaUrl) return undefined;
    let literal;
    if (spec.type === "Literal" && typeof spec.value === "string") literal = spec.value;
    else if (spec.type === "TemplateLiteral" && spec.expressions.length === 0) {
        literal = spec.quasis[0].value.cooked;
    }
    return typeof literal === "string" && /^\.\.?\//.test(literal) ? literal : undefined;
}

const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range"]);

/**
 * One iterative walk (no recursion: a 1 MB bundle can nest deeper than the
 * JS stack likes) recording each node's parent, every anchor, and every
 * `Identifier` by name.
 */
function index(ast) {
    const parents = new Map();
    const anchors = [];
    const identifiers = new Map();
    const stack = [ast];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node.type === "NewExpression") {
            const literal = anchorLiteral(node);
            if (literal !== undefined) anchors.push({ node, literal });
        } else if (node.type === "Identifier") {
            let list = identifiers.get(node.name);
            if (list === undefined) {
                list = [];
                identifiers.set(node.name, list);
            }
            list.push(node);
        }
        for (const key in node) {
            if (SKIP_KEYS.has(key)) continue;
            const value = node[key];
            if (value === null || typeof value !== "object") continue;
            if (Array.isArray(value)) {
                for (const child of value) {
                    if (child !== null && typeof child?.type === "string") {
                        parents.set(child, node);
                        stack.push(child);
                    }
                }
            } else if (typeof value.type === "string") {
                parents.set(value, node);
                stack.push(value);
            }
        }
    }
    anchors.sort((a, b) => a.node.start - b.node.start);
    return { parents, anchors, identifiers };
}

const FUNCTION_TYPES = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
]);
const BLOCK_SCOPE_TYPES = new Set([
    "BlockStatement",
    "StaticBlock",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "SwitchStatement",
    "Program",
    ...FUNCTION_TYPES,
]);

/** The node a declarator's binding is visible in (`var`: function; else block). */
function bindingScope(declarator, parents) {
    const declaration = parents.get(declarator);
    const scopeTypes =
        declaration?.kind === "var" ? new Set(["Program", ...FUNCTION_TYPES]) : BLOCK_SCOPE_TYPES;
    let cur = parents.get(declaration);
    while (cur !== undefined && !scopeTypes.has(cur.type)) cur = parents.get(cur);
    return cur;
}

function combine(verdicts) {
    if (verdicts.includes(EXCLUDED)) return EXCLUDED;
    if (verdicts.includes(READ)) return READ;
    return UNKNOWN;
}

/** Follow a value (the anchor, or a reference to a binding holding it) to its consumer. */
function classifyValue(start, ctx, hops) {
    let cur = start;
    for (;;) {
        const p = ctx.parents.get(cur);
        if (p === undefined) return UNKNOWN;
        switch (p.type) {
            case "CallExpression": {
                if (p.arguments[0] !== cur) return UNKNOWN;
                const name = calleeName(p.callee);
                if (EXCLUDED_CALLEES.has(name)) return EXCLUDED;
                if (READ_CALLEES.has(name)) return READ;
                if (PATH_CALLEES.has(name)) {
                    cur = p;
                    continue;
                }
                return feedsWebAssembly(p, ctx.parents) ? READ : UNKNOWN;
            }
            case "NewExpression":
                return p.arguments[0] === cur && WORKER_CTORS.has(calleeName(p.callee))
                    ? EXCLUDED
                    : UNKNOWN;
            case "ImportExpression":
                return EXCLUDED;
            case "MemberExpression":
                if (p.object === cur && !p.computed && URL_PATH_MEMBERS.has(p.property.name)) {
                    cur = p;
                    continue;
                }
                return UNKNOWN;
            case "ChainExpression":
                cur = p;
                continue;
            case "VariableDeclarator":
                if (p.init !== cur || p.id.type !== "Identifier" || hops >= MAX_BINDING_HOPS)
                    return UNKNOWN;
                return classifyBinding(p, ctx, hops + 1);
            default:
                return UNKNOWN;
        }
    }
}

/**
 * Every use of `declarator`'s binding inside its scope, classified; one
 * EXCLUDED use vetoes the whole binding (a Worker loading it must keep it).
 * Name-based within the scope's range — a shadowing inner binding of the same
 * name is counted too, which can only make the answer MORE conservative.
 */
function classifyBinding(declarator, ctx, hops) {
    const scope = bindingScope(declarator, ctx.parents);
    if (scope === undefined) return UNKNOWN;
    const uses = (ctx.identifiers.get(declarator.id.name) ?? []).filter(
        (id) => id !== declarator.id && id.start >= scope.start && id.end <= scope.end,
    );
    return combine(uses.map((id) => classifyValue(id, ctx, hops)));
}

const PARSE_OPTIONS = {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
};

/**
 * Every real (code-position) `new URL(<relative literal>, import.meta.url)`
 * anchor in `src` with what it feeds — `"read"` (the only kind
 * `rewriteAssetAnchors` rewrites), `"excluded"` (Worker / fetch / require /
 * dynamic import) or `"unknown"`. A module the prefilter does not match is
 * never parsed. On a parse failure, no anchors and the error message: the
 * caller leaves the module as written.
 *
 * @param {string} src
 * @returns {{ anchors: { literal: string, start: number, end: number, consumer: "read" | "excluded" | "unknown" }[], parseError?: string }}
 */
export function analyzeAssetAnchors(src) {
    if (!hasAssetAnchorCandidate(src)) return { anchors: [] };
    let ast;
    try {
        ast = parse(src, PARSE_OPTIONS);
    } catch (err) {
        return { anchors: [], parseError: err instanceof Error ? err.message : String(err) };
    }
    const ctx = index(ast);
    return {
        anchors: ctx.anchors.map(({ node, literal }) => ({
            literal,
            start: node.start,
            end: node.end,
            consumer: classifyValue(node, ctx, 0),
        })),
    };
}

// Script mode: `bun asset-anchor-analyze.mjs < module.js` prints the analysis
// as JSON. Only when run directly — importing this module has no side effect.
if (import.meta.main) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write(
        JSON.stringify(analyzeAssetAnchors(Buffer.concat(chunks).toString("utf8"))),
    );
}
