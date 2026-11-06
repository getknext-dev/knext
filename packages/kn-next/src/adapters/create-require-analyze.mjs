/**
 * The `createRequire(import.meta.url)` consumer analysis behind the strict
 * require check (#2614; see entry-require-staticize.mjs for the whole
 * mechanism): parse a server-output module with acorn and report, for every
 * call to a `createRequire` import alias that is anchored at `import.meta.url`
 * (or its per-module-merge getter form, `{get value(){return x.url}}.value`),
 * WHERE ITS VALUE GOES.
 *
 *   - `binding`  — assigned to an identifier (`X = create(...)`, or through the
 *     `(() => create(...))()` IIFE rolldown emits): `name` is that identifier.
 *   - `direct`   — called at once (`create(...)(spec)`): `dynamic` is true when
 *     the argument is not one plain string literal, else `spec` is its value.
 *     A dynamic call whose argument is the literal-join idiom (`['io',
 *     'redis'].join('')`, directly or through a name the module binds once and
 *     writes once) AND folds to exactly `FOLDED_RUNTIME_PACKAGE` also carries
 *     `folded`, that package name. Any other folded value is an ordinary
 *     non-literal direct require. See `foldSpecifier`.
 *   - `resolve`  — `create(...).resolve(...)`, an existence probe. Accounted for,
 *     never embedded and never strict-failed (Node's own `require.resolve`
 *     idiom, which callers catch).
 *   - `discarded` — its value is provably thrown away: an expression statement,
 *     or a non-final element of a sequence whose own value is discarded. This is
 *     decided from the TREE, so a string, a regex, a `/`, a comment or a long
 *     sibling before it cannot defeat the proof (#2614).
 *   - `handed`   — anything else: returned, passed, stored, the value of an
 *     enclosing expression. Its require cannot be verified, so the caller
 *     reports it as an unrecognised binding.
 *
 * References are resolved by SCOPE (see `buildScopes`), and the creator itself
 * is followed, so each of these is either recorded as one of the sites above or
 * reported as `handed` (#2666):
 *
 *   - an alias of the creator, `const c = e` (followed); the creator copied
 *     anywhere else, stored, passed, returned or exported (`handed`);
 *   - `import * as m` / `import m` / `{ default as m }` from `module`, calling
 *     `m.createRequire(...)`; the namespace passed on or `m.default` (`handed`);
 *   - `const { createRequire: e } = await import("node:module")` and
 *     `const m = await import("node:module")`; any other dynamic import of
 *     `module` (`handed`);
 *   - a made require (`binding`) that is then copied, stored, passed, returned,
 *     `.bind`/`.call`ed or exported as a default (`handed`); only calls through
 *     it, `.resolve`, `.cache`, `typeof` and a NAMED export are understood;
 *   - a create whose anchor may come from `import.meta` but is not
 *     `import.meta.url` itself, i.e. a wrapper `function mk(u) { return e(u) }`
 *     or `e(new URL(".", import.meta.url).href)` (`handed`). A create anchored
 *     somewhere else (a literal, the cwd) was never embedded by this check and
 *     is left alone.
 *
 * A module acorn cannot parse is reported as `parseError` and never as clean:
 * the caller treats a create it cannot see as unrecognised.
 *
 * ## Why a separate process
 *
 * `entry-require-staticize.mjs` is in the compile script's import closure,
 * which must stay node-builtins-only (the Bun base-executable seal,
 * `bun-base-exe-seam.test.ts`). acorn is a third-party package, so it is run
 * out of process, the same way `asset-anchor-analyze.mjs` is (shipped beside
 * the compile script, fails closed when absent).
 *
 * Script mode: `bun create-require-analyze.mjs < module.js` prints the analysis
 * as JSON. Only when run directly — importing this module has no side effect.
 */

import { parse } from "acorn";

/** Module specifiers whose `createRequire` export is the one we track. */
const CREATE_REQUIRE_SOURCES = new Set(["module", "node:module"]);

/** Keys of an acorn node that never hold child nodes. */
const SKIP_KEYS = new Set(["type", "start", "end"]);

/**
 * Parse as an ES module, then as a classic script for CommonJS-style code (its
 * `with`, legacy octal literals and top-level `return` are not modules). A
 * module that fails both is not analysable.
 */
function parseSource(src) {
    try {
        return parse(src, {
            ecmaVersion: "latest",
            sourceType: "module",
            allowHashBang: true,
            allowAwaitOutsideFunction: true,
        });
    } catch (moduleError) {
        try {
            return parse(src, {
                ecmaVersion: "latest",
                sourceType: "script",
                allowHashBang: true,
                allowReturnOutsideFunction: true,
            });
        } catch {
            throw moduleError;
        }
    }
}

/** `import.meta.url` */
function isImportMetaUrl(node) {
    return (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "url" &&
        node.object.type === "MetaProperty" &&
        node.object.meta.name === "import" &&
        node.object.property.name === "meta"
    );
}

/** `{get value(){return <identifier>.url}}.value` — rolldown's per-module-merge getter. */
function isGetterIndirection(node) {
    if (
        node.type !== "MemberExpression" ||
        node.computed ||
        node.property.name !== "value" ||
        node.object.type !== "ObjectExpression" ||
        node.object.properties.length !== 1
    ) {
        return false;
    }
    const prop = node.object.properties[0];
    if (
        prop.type !== "Property" ||
        prop.kind !== "get" ||
        prop.computed ||
        prop.key.name !== "value" ||
        prop.value.type !== "FunctionExpression"
    ) {
        return false;
    }
    const body = prop.value.body.body;
    if (body.length !== 1 || body[0].type !== "ReturnStatement") return false;
    const ret = body[0].argument;
    return (
        ret?.type === "MemberExpression" &&
        !ret.computed &&
        ret.property.name === "url" &&
        ret.object.type === "Identifier"
    );
}

/** A plain string argument's value, or null (a template with no substitution counts). */
function literalSpec(node) {
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
        return node.quasis[0].value.cooked;
    }
    return null;
}

/**
 * Whether the value of `node` is provably thrown away: an expression statement,
 * or a non-final element of a sequence whose own value is thrown away.
 */
function isDiscarded(node, parents) {
    const parent = parents.get(node);
    if (!parent) return false;
    if (parent.type === "ExpressionStatement") return true;
    if (parent.type === "SequenceExpression") {
        const expressions = parent.expressions;
        if (node !== expressions[expressions.length - 1]) return true;
        return isDiscarded(parent, parents);
    }
    return false;
}

/**
 * The ONE package a computed runtime require may name without failing a strict
 * build: ioredis, loaded by `loadRedisCtor()` in packages/lib/src/redis/
 * ioredis-ctor.ts with the specifier assembled (`['io', 'redis'].join('')`) so no
 * bundler follows it. The load is dead under Bun: `createRedisClient()` in
 * packages/lib/src/redis/client.ts takes the `bunRedisAvailable(scope)` branch
 * and constructs `Bun.RedisClient`, returning before `loadRedisCtor()` is ever
 * reached on the createRedisClient path. Not every path is covered: the generic
 * cache handler (adapters/cache-handler.js) loads ioredis with a computed
 * `import()` when `KNEXT_CACHE_REDIS_CLIENT=ioredis` forces it under Bun, and that
 * load fails in a compiled binary (the bundler turns it into a throw), loudly,
 * with an in-memory fallback. Nothing else has even the createRedisClient
 * guarantee, so nothing else is exempt: `sharp`, a relative or absolute path,
 * `node:fs` all stay failures even when assembled the same way.
 *
 * The exemption goes by NAME, not by caller: it applies to a `createRequire(
 * import.meta.url)` load of exactly this string in ANY module, including an app's
 * own code. It does not check that the load sits behind the Bun guard.
 */
export const FOLDED_RUNTIME_PACKAGE = "ioredis";

/**
 * `['io', 'redis'].join('')` -> "ioredis": the one idiom the repo uses to keep a
 * package name invisible to a bundler. Only an array of plain string literals
 * joined with the empty string folds; anything else (a variable element, another
 * separator, a template with substitutions) returns null.
 */
function foldJoin(node) {
    if (
        node.type !== "CallExpression" ||
        node.callee.type !== "MemberExpression" ||
        node.callee.computed ||
        node.callee.property.name !== "join" ||
        node.callee.object.type !== "ArrayExpression" ||
        node.arguments.length !== 1 ||
        literalSpec(node.arguments[0]) !== ""
    ) {
        return null;
    }
    let out = "";
    for (const el of node.callee.object.elements) {
        const part = el === null ? null : literalSpec(el);
        if (part === null) return null;
        out += part;
    }
    return out;
}

/** Every identifier a binding pattern introduces. */
function patternNames(node, into) {
    if (!node) return;
    switch (node.type) {
        case "Identifier":
            into.push(node.name);
            break;
        case "ObjectPattern":
            for (const p of node.properties) {
                patternNames(p.type === "RestElement" ? p.argument : p.value, into);
            }
            break;
        case "ArrayPattern":
            for (const el of node.elements) patternNames(el, into);
            break;
        case "RestElement":
            patternNames(node.argument, into);
            break;
        case "AssignmentPattern":
            patternNames(node.left, into);
            break;
    }
}

/**
 * Per name: how many times the module binds it, every value written to it by a
 * declarator initialiser or a plain `name = value` assignment (bundler output
 * hoists `let a, b;` and assigns inside a lazy init function), and whether any
 * other write touches it (compound or destructuring assignment, `++`, a `for`
 * target).
 *
 * What this is NOT: scope analysis. It counts binding sites by NAME across the
 * whole module, so it cannot tell two functions' same-named locals apart (it
 * refuses both, which is safe) but it also cannot see a name that resolves to
 * something else, e.g. `{ const n = [...].join('') }` read as `n` from outside
 * the block, a free global of that name defined in another function, `eval`, or
 * a patched `Array.prototype.join`. Those would be folded wrongly.
 *
 * That is acceptable ONLY because the sole value `foldSpecifier` lets through is
 * `FOLDED_RUNTIME_PACKAGE`: a wrong fold can at worst exempt a load that really
 * names ioredis, which is reported by name (never silently dropped) but not
 * failed. It is not a sound constant propagator and must not be widened without
 * scope analysis.
 */
function bindingFacts(ast) {
    const bound = new Map();
    const writes = new Map();
    const reassigned = new Set();
    const write = (name, value) => writes.set(name, [...(writes.get(name) ?? []), value]);
    const bind = (name) => bound.set(name, (bound.get(name) ?? 0) + 1);
    const stack = [ast];
    while (stack.length > 0) {
        const node = stack.pop();
        const names = [];
        switch (node.type) {
            case "VariableDeclarator":
                patternNames(node.id, names);
                for (const n of names) bind(n);
                if (node.id.type === "Identifier" && node.init) write(node.id.name, node.init);
                break;
            case "FunctionDeclaration":
            case "FunctionExpression":
            case "ArrowFunctionExpression":
                if (node.id) names.push(node.id.name);
                for (const p of node.params) patternNames(p, names);
                for (const n of names) bind(n);
                break;
            case "ClassDeclaration":
            case "ClassExpression":
                if (node.id) bind(node.id.name);
                break;
            case "CatchClause":
                patternNames(node.param, names);
                for (const n of names) bind(n);
                break;
            case "ImportSpecifier":
            case "ImportDefaultSpecifier":
            case "ImportNamespaceSpecifier":
                bind(node.local.name);
                break;
            case "AssignmentExpression":
                if (node.operator === "=" && node.left.type === "Identifier") {
                    write(node.left.name, node.right);
                } else {
                    patternNames(node.left, names);
                    for (const n of names) reassigned.add(n);
                }
                break;
            case "UpdateExpression":
                if (node.argument.type === "Identifier") reassigned.add(node.argument.name);
                break;
            case "ForInStatement":
            case "ForOfStatement":
                if (node.left.type !== "VariableDeclaration") {
                    patternNames(node.left, names);
                    for (const n of names) reassigned.add(n);
                }
                break;
        }
        for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key)) continue;
            const value = node[key];
            for (const child of Array.isArray(value) ? value : [value]) {
                if (child && typeof child.type === "string") stack.push(child);
            }
        }
    }
    return { bound, writes, reassigned };
}

/**
 * `FOLDED_RUNTIME_PACKAGE` when a dynamic `create(...)(arg)` argument is the
 * literal-join idiom itself, or a name bound exactly once and written exactly
 * once with that idiom, and the idiom folds to exactly that name. Null for
 * everything else, including every other folded value.
 */
function foldSpecifier(arg, facts) {
    let folded;
    if (arg.type === "Identifier") {
        if (facts.bound.get(arg.name) !== 1 || facts.reassigned.has(arg.name)) return null;
        const writes = facts.writes.get(arg.name) ?? [];
        folded = writes.length === 1 ? foldJoin(writes[0]) : null;
    } else {
        folded = foldJoin(arg);
    }
    return folded === FOLDED_RUNTIME_PACKAGE ? folded : null;
}

/** Classify one `createRequire(import.meta.url)` call by where its value goes. */
function classify(call, parents, getFacts) {
    let value = call;
    let parent = parents.get(value);

    // rolldown's binding shape: `(() => create(import.meta.url))()`.
    if (parent?.type === "ArrowFunctionExpression" && parent.body === value) {
        const iife = parents.get(parent);
        if (
            iife?.type === "CallExpression" &&
            iife.callee === parent &&
            iife.arguments.length === 0
        ) {
            value = iife;
            parent = parents.get(iife);
        }
    }

    if (
        parent?.type === "VariableDeclarator" &&
        parent.init === value &&
        parent.id.type === "Identifier"
    ) {
        return { kind: "binding", name: parent.id.name };
    }
    if (
        parent?.type === "AssignmentExpression" &&
        parent.operator === "=" &&
        parent.right === value &&
        parent.left.type === "Identifier"
    ) {
        return { kind: "binding", name: parent.left.name };
    }

    if (parent?.type === "CallExpression" && parent.callee === value) {
        if (parent.arguments.length === 1) {
            const spec = literalSpec(parent.arguments[0]);
            if (spec !== null) return { kind: "direct", dynamic: false, spec };
        }
        const folded =
            parent.arguments.length === 1
                ? foldSpecifier(parent.arguments[0], getFacts())
                : null;
        return folded === null
            ? { kind: "direct", dynamic: true, spec: null }
            : { kind: "direct", dynamic: true, spec: null, folded };
    }

    if (
        parent?.type === "MemberExpression" &&
        parent.object === value &&
        !parent.computed &&
        parent.property.name === "resolve" &&
        parents.get(parent)?.type === "CallExpression" &&
        parents.get(parent).callee === parent
    ) {
        return { kind: "resolve" };
    }

    if (isDiscarded(value, parents)) return { kind: "discarded" };
    return { kind: "handed" };
}

/** Parent of every node, built with one explicit-stack walk (no recursion on a deep tree). */
function indexParents(ast) {
    const parents = new Map();
    const stack = [ast];
    while (stack.length > 0) {
        const node = stack.pop();
        for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key)) continue;
            const value = node[key];
            for (const child of Array.isArray(value) ? value : [value]) {
                if (child && typeof child.type === "string") {
                    parents.set(child, node);
                    stack.push(child);
                }
            }
        }
    }
    return parents;
}

/**
 * Scope analysis (#2666): which BINDING each identifier reference resolves to.
 *
 * The check used to count a name wherever it appeared, so a one-letter minified
 * name could neither be followed (an alias) nor trusted (a parameter that happens
 * to share the name). This resolves references properly: `var` and function-body
 * bindings hoist to the nearest function scope, `let`/`const`/`class`/block-level
 * functions belong to their block, a function's own name and parameters belong to
 * it, a `catch` parameter to its clause. Resolution runs AFTER the whole tree is
 * walked, so a use before its (hoisted) declaration still resolves to it.
 *
 * Deliberately NOT modelled (each errs toward the safe side, a name resolving to
 * the OUTER binding, which can only report a hand-off that is not one): sloppy-
 * mode block-function hoisting, `with`, `eval`, and the temporal dead zone.
 *
 * Recursive over the tree: a module nested deeper than the stack throws
 * RangeError, which the caller turns into a parse failure (fails closed).
 */
function buildScopes(ast) {
    /** Identifier node -> the Binding it declares. */
    const declOf = new Map();
    /** Every identifier reference: { node, scope, role, value?, binding }. */
    const refs = [];
    /** Every variable declarator. */
    const declarators = [];
    /** Every dynamic `import(...)`. */
    const dynamicImports = [];
    /** Every `x.getBuiltinModule(...)` call. */
    const builtinModuleCalls = [];

    const newScope = (parent, isFunction) => ({ parent, isFunction, names: new Map() });
    const functionScopeOf = (scope) => {
        let s = scope;
        while (!s.isFunction) s = s.parent;
        return s;
    };
    const declare = (scope, id, kind) => {
        let binding = scope.names.get(id.name);
        if (!binding) {
            binding = {
                name: id.name,
                kind,
                decls: 0,
                init: null,
                writes: [],
                otherWrite: false,
                refs: [],
            };
            scope.names.set(id.name, binding);
        }
        binding.decls++;
        declOf.set(id, binding);
        return binding;
    };

    const declarePattern = (node, scope, kind) => {
        if (!node) return;
        switch (node.type) {
            case "Identifier":
                declare(scope, node, kind);
                break;
            case "ObjectPattern":
                for (const p of node.properties) {
                    if (p.type === "RestElement") {
                        declarePattern(p.argument, scope, kind);
                    } else {
                        if (p.computed) visit(p.key, scope);
                        declarePattern(p.value, scope, kind);
                    }
                }
                break;
            case "ArrayPattern":
                for (const el of node.elements) declarePattern(el, scope, kind);
                break;
            case "RestElement":
                declarePattern(node.argument, scope, kind);
                break;
            case "AssignmentPattern":
                declarePattern(node.left, scope, kind);
                visit(node.right, scope);
                break;
        }
    };

    /** An assignment target that is a pattern: every name in it is written by something unknown. */
    const writePattern = (node, scope) => {
        if (!node) return;
        switch (node.type) {
            case "Identifier":
                refs.push({ node, scope, role: "writeOther" });
                break;
            case "ObjectPattern":
                for (const p of node.properties) {
                    if (p.type === "RestElement") {
                        writePattern(p.argument, scope);
                    } else {
                        if (p.computed) visit(p.key, scope);
                        writePattern(p.value, scope);
                    }
                }
                break;
            case "ArrayPattern":
                for (const el of node.elements) writePattern(el, scope);
                break;
            case "RestElement":
                writePattern(node.argument, scope);
                break;
            case "AssignmentPattern":
                writePattern(node.left, scope);
                visit(node.right, scope);
                break;
            default:
                visit(node, scope); // a member expression target
        }
    };

    const visitFunction = (node, scope) => {
        const inner = newScope(scope, true);
        if (node.type === "FunctionExpression" && node.id) declare(inner, node.id, "fname");
        for (const p of node.params) declarePattern(p, inner, "param");
        if (node.body.type === "BlockStatement") {
            for (const stmt of node.body.body) visit(stmt, inner);
        } else {
            visit(node.body, inner);
        }
    };

    const visitClass = (node, scope) => {
        let inner = scope;
        if (node.type === "ClassDeclaration" && node.id) {
            declare(scope, node.id, "class");
        } else if (node.id) {
            inner = newScope(scope, false);
            declare(inner, node.id, "class");
        }
        if (node.superClass) visit(node.superClass, inner);
        for (const member of node.body.body) {
            if (member.type === "StaticBlock") {
                const block = newScope(inner, true);
                for (const stmt of member.body) visit(stmt, block);
                continue;
            }
            if (member.computed) visit(member.key, inner);
            if (member.value) visit(member.value, inner);
        }
    };

    const visitDeclaration = (node, scope) => {
        const target = node.kind === "var" ? functionScopeOf(scope) : scope;
        for (const decl of node.declarations) {
            if (decl.id.type === "Identifier") {
                const binding = declare(target, decl.id, node.kind);
                if (decl.init) {
                    binding.init = decl.init;
                    binding.writes.push(decl.init);
                }
            } else {
                declarePattern(decl.id, target, node.kind);
            }
            if (decl.init) visit(decl.init, scope);
            declarators.push(decl);
        }
    };

    /** `for (x of y)` / `for (var x in y)`: the target is written by the loop. */
    const visitLoopTarget = (left, scope) => {
        if (left.type === "VariableDeclaration") {
            visitDeclaration(left, scope);
            const target = left.kind === "var" ? functionScopeOf(scope) : scope;
            for (const decl of left.declarations) {
                const names = [];
                patternNames(decl.id, names);
                for (const name of names) {
                    const binding = target.names.get(name);
                    if (binding) binding.otherWrite = true;
                }
            }
        } else {
            writePattern(left, scope);
        }
    };

    const visit = (node, scope) => {
        switch (node.type) {
            case "Identifier":
                refs.push({ node, scope, role: "read" });
                return;
            case "MemberExpression":
                visit(node.object, scope);
                if (node.computed) visit(node.property, scope);
                return;
            case "Property":
                if (node.computed) visit(node.key, scope);
                visit(node.value, scope);
                return;
            case "MethodDefinition":
            case "PropertyDefinition":
                if (node.computed) visit(node.key, scope);
                if (node.value) visit(node.value, scope);
                return;
            case "MetaProperty":
            case "BreakStatement":
            case "ContinueStatement":
            case "ExportAllDeclaration":
                return;
            case "LabeledStatement":
                visit(node.body, scope);
                return;
            case "VariableDeclaration":
                visitDeclaration(node, scope);
                return;
            case "FunctionDeclaration":
                declare(scope, node.id, "function");
                visitFunction(node, scope);
                return;
            case "FunctionExpression":
            case "ArrowFunctionExpression":
                visitFunction(node, scope);
                return;
            case "ClassDeclaration":
            case "ClassExpression":
                visitClass(node, scope);
                return;
            case "BlockStatement": {
                const block = newScope(scope, false);
                for (const stmt of node.body) visit(stmt, block);
                return;
            }
            case "ForStatement": {
                const loop = newScope(scope, false);
                if (node.init) visit(node.init, loop);
                if (node.test) visit(node.test, loop);
                if (node.update) visit(node.update, loop);
                visit(node.body, loop);
                return;
            }
            case "ForInStatement":
            case "ForOfStatement": {
                const loop = newScope(scope, false);
                visitLoopTarget(node.left, loop);
                visit(node.right, loop);
                visit(node.body, loop);
                return;
            }
            case "CatchClause": {
                const clause = newScope(scope, false);
                declarePattern(node.param, clause, "catch");
                visit(node.body, clause);
                return;
            }
            case "SwitchStatement": {
                visit(node.discriminant, scope);
                const block = newScope(scope, false);
                for (const c of node.cases) {
                    if (c.test) visit(c.test, block);
                    for (const stmt of c.consequent) visit(stmt, block);
                }
                return;
            }
            case "AssignmentExpression":
                if (node.left.type === "Identifier") {
                    refs.push(
                        node.operator === "="
                            ? { node: node.left, scope, role: "write", value: node.right }
                            : { node: node.left, scope, role: "writeOther" },
                    );
                } else {
                    writePattern(node.left, scope);
                }
                visit(node.right, scope);
                return;
            case "UpdateExpression":
                if (node.argument.type === "Identifier") {
                    refs.push({ node: node.argument, scope, role: "writeOther" });
                } else {
                    visit(node.argument, scope);
                }
                return;
            case "ImportDeclaration":
                for (const spec of node.specifiers) declare(scope, spec.local, "import");
                return;
            case "ExportNamedDeclaration":
                if (node.declaration) visit(node.declaration, scope);
                if (!node.source) {
                    for (const spec of node.specifiers) {
                        refs.push({ node: spec.local, scope, role: "export" });
                    }
                }
                return;
            case "ExportDefaultDeclaration":
                visit(node.declaration, scope);
                return;
            case "CallExpression":
                if (
                    node.callee.type === "MemberExpression" &&
                    !node.callee.computed &&
                    node.callee.property.name === "getBuiltinModule"
                ) {
                    builtinModuleCalls.push(node);
                }
                break;
            case "ImportExpression":
                dynamicImports.push(node);
                visit(node.source, scope);
                if (node.options) visit(node.options, scope);
                return;
        }
        for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key)) continue;
            const value = node[key];
            for (const child of Array.isArray(value) ? value : [value]) {
                if (child && typeof child.type === "string") visit(child, scope);
            }
        }
    };

    const top = newScope(null, true);
    for (const stmt of ast.body) visit(stmt, top);

    /** Identifier reference node -> Binding. */
    const refBinding = new Map();
    for (const ref of refs) {
        let scope = ref.scope;
        let binding;
        while (scope && !(binding = scope.names.get(ref.node.name))) scope = scope.parent;
        if (!binding) continue;
        refBinding.set(ref.node, binding);
        if (ref.role === "write") binding.writes.push(ref.value);
        else if (ref.role === "writeOther") binding.otherWrite = true;
        else binding.refs.push(ref);
    }
    return { declOf, refBinding, declarators, dynamicImports, builtinModuleCalls };
}

/** The Binding an identifier node declares or references. */
function bindingOf(node, scopes) {
    return scopes.declOf.get(node) ?? scopes.refBinding.get(node) ?? null;
}

/** Declared once, written once, by its own initialiser: its value is that initialiser. */
function isSingleValue(binding) {
    return (
        binding !== null &&
        binding.decls === 1 &&
        !binding.otherWrite &&
        binding.init !== null &&
        binding.writes.length === 1 &&
        binding.writes[0] === binding.init
    );
}

/** `import.meta.url`, or a binding that is nothing but that. */
function isMetaUrlValue(node, scopes) {
    if (isImportMetaUrl(node) || isGetterIndirection(node)) return true;
    if (node.type !== "Identifier") return false;
    const binding = bindingOf(node, scopes);
    return (
        isSingleValue(binding) &&
        (isImportMetaUrl(binding.init) || isGetterIndirection(binding.init))
    );
}

/**
 * Whether an expression's value may come from `import.meta`: it mentions it, or
 * names a parameter (a wrapper's argument: the anchor is whatever the caller
 * passed), or names a binding whose single value does. A literal, the cwd or
 * `__filename` is anchored elsewhere and is not this.
 */
function mayDeriveFromImportMeta(root, scopes) {
    const seen = new Set();
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node.type === "MetaProperty") return true;
        if (node.type === "Identifier") {
            const binding = scopes.refBinding.get(node) ?? null;
            if (binding === null || seen.has(binding)) continue;
            seen.add(binding);
            if (binding.kind === "param") return true;
            if (isSingleValue(binding)) stack.push(binding.init);
            continue;
        }
        for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key)) continue;
            const value = node[key];
            for (const child of Array.isArray(value) ? value : [value]) {
                if (child && typeof child.type === "string") stack.push(child);
            }
        }
    }
    return false;
}

/**
 * Whether a READ of a made require is one the build understands: a call through
 * it (`r("pkg")`, `r(name)`), `r.resolve` / `r.cache`, a `typeof`, or (when
 * `allowExport`) a named export, which the cross-chunk plan follows by name.
 * Anything else (copied, stored, passed, returned, `.bind`/`.call`) hides which
 * packages it loads.
 */
function isUnderstoodRequireUse(ref, parents, allowExport) {
    if (ref.role === "export") return allowExport;
    const parent = parents.get(ref.node);
    if (!parent) return false;
    // An optional call (`r?.("pkg")`) is not followed: the literal scan reads only
    // plain `r("pkg")`, so the package would be silently left out.
    if (parent.type === "CallExpression" && parent.callee === ref.node) return !parent.optional;
    if (parent.type === "UnaryExpression" && parent.operator === "typeof") return true;
    if (
        parent.type === "MemberExpression" &&
        parent.object === ref.node &&
        !parent.computed &&
        parent.property.name === "main"
    ) {
        // `require.main` (`require.main === module`, `require.main === void 0`) is
        // a probe, not a load; `require.main.require(...)` and passing it on are.
        const user = parents.get(parent);
        return !(
            (user?.type === "MemberExpression" && user.object === parent) ||
            (user?.type === "CallExpression" && user.callee === parent) ||
            (user?.type === "CallExpression" && user.arguments.includes(parent))
        );
    }
    return (
        parent.type === "MemberExpression" &&
        parent.object === ref.node &&
        !parent.computed &&
        (parent.property.name === "resolve" || parent.property.name === "cache")
    );
}

/**
 * The feature-detect shim bundlers wrap a require in (`__require`):
 * `K = (p => typeof R < "u" ? R : typeof Proxy < "u" ? new Proxy(p, {...}) : p)(
 * function (n) { if (typeof R < "u") return R.apply(this, arguments); throw ... })`.
 * R is only FORWARDED into K, so K is the same require under another name. Returns
 * the identifier node of K when every use of R that is not already understood sits
 * inside one such initialiser, else null (R is then reported as before).
 */
function forwardedTo(binding, parents, scopes, allowExport) {
    const stray = binding.refs.filter((r) => !isUnderstoodRequireUse(r, parents, allowExport));
    if (stray.length === 0) return null;
    const isForward = (ref) => {
        const parent = parents.get(ref.node);
        if (parent?.type === "ConditionalExpression") {
            return parent.consequent === ref.node || parent.alternate === ref.node;
        }
        if (
            parent?.type === "MemberExpression" &&
            parent.object === ref.node &&
            !parent.computed &&
            parent.property.name === "apply"
        ) {
            const call = parents.get(parent);
            return call?.type === "CallExpression" && call.callee === parent;
        }
        return false;
    };
    if (!stray.every(isForward)) return null;
    // The outermost expression all of them share must be the initialiser of K.
    const chain = (node) => {
        const out = [];
        for (let n = node; n; n = parents.get(n)) out.push(n);
        return out;
    };
    const first = chain(stray[0].node);
    for (const candidate of first) {
        if (candidate.type !== "CallExpression" || candidate.callee.type !== "ArrowFunctionExpression") {
            continue;
        }
        if (candidate.arguments.length !== 1 || candidate.arguments[0].type !== "FunctionExpression") {
            continue;
        }
        const inside = (node) => chain(node).includes(candidate);
        if (!stray.every((r) => inside(r.node))) continue;
        const holder = parents.get(candidate);
        let id = null;
        if (holder?.type === "VariableDeclarator" && holder.init === candidate) id = holder.id;
        else if (
            holder?.type === "AssignmentExpression" &&
            holder.operator === "=" &&
            holder.right === candidate
        ) {
            id = holder.left;
        }
        if (id?.type === "Identifier" && bindingOf(id, scopes) !== null) return id;
    }
    return null;
}

/** Whether a made require has any use the build does not understand. */
function requireBindingEscapes(binding, parents, allowExport) {
    return binding.refs.some((ref) => !isUnderstoodRequireUse(ref, parents, allowExport));
}

/** Cheap pre-filter: does a module mention `createRequire` or import `module` at all? */
const MODULE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](?:node:)?module["']/;
function mentionsCreateRequire(src) {
    return (
        src.includes("createRequire") ||
        src.includes("getBuiltinModule") ||
        MODULE_IMPORT.test(src)
    );
}

/**
 * @param {string} src
 * @returns {{ aliases: string[], sites: object[], parseError: string | null }}
 */
export function analyzeCreateRequire(src) {
    if (!mentionsCreateRequire(src)) return { aliases: [], sites: [], parseError: null };
    let ast;
    try {
        ast = parseSource(src);
    } catch (err) {
        return { aliases: [], sites: [], parseError: String(err?.message ?? err) };
    }
    try {
        return analyzeParsed(ast);
    } catch (err) {
        // A tree deeper than the stack: nothing was proven, so say so.
        return {
            aliases: [],
            sites: [],
            parseError: `scope analysis failed: ${String(err?.message ?? err)}`,
        };
    }
}

function analyzeParsed(ast) {
    const parents = indexParents(ast);
    const scopes = buildScopes(ast);

    // The creator (`createRequire` itself) and the `module` namespace, as bindings.
    const creators = new Set();
    const namespaces = new Set();
    const sites = [];
    const consumed = new Set(); // reference nodes whose use is accounted for
    const aliases = [];

    for (const node of ast.body) {
        if (node.type !== "ImportDeclaration") continue;
        if (!CREATE_REQUIRE_SOURCES.has(node.source.value)) continue;
        for (const spec of node.specifiers) {
            const binding = scopes.declOf.get(spec.local);
            if (spec.type === "ImportSpecifier") {
                const imported = spec.imported.name ?? spec.imported.value;
                if (imported === "createRequire") {
                    creators.add(binding);
                    aliases.push(spec.local.name);
                } else if (imported === "default") {
                    namespaces.add(binding);
                }
            } else {
                namespaces.add(binding); // default and namespace imports
            }
        }
    }

    // `await import("node:module")`, destructured or bound whole.
    const handledImports = new Set();
    // Pairs of (pattern, import expression) the pattern receives: the whole
    // declarator for `await import(...)`, one element each for
    // `const [{ createRequire: c }, p] = await Promise.all([import(...), ...])`.
    const importBindings = [];
    for (const declarator of scopes.declarators) {
        const init = declarator.init;
        if (init?.type !== "AwaitExpression") continue;
        if (init.argument.type === "ImportExpression") {
            importBindings.push([declarator.id, init.argument]);
        } else if (
            init.argument.type === "CallExpression" &&
            init.argument.callee.type === "MemberExpression" &&
            !init.argument.callee.computed &&
            init.argument.callee.object.type === "Identifier" &&
            init.argument.callee.object.name === "Promise" &&
            init.argument.callee.property.name === "all" &&
            init.argument.arguments.length === 1 &&
            init.argument.arguments[0].type === "ArrayExpression" &&
            declarator.id.type === "ArrayPattern"
        ) {
            const items = init.argument.arguments[0].elements;
            declarator.id.elements.forEach((el, i) => {
                if (el && items[i]?.type === "ImportExpression") importBindings.push([el, items[i]]);
            });
        }
    }
    for (const [id, importNode] of importBindings) {
        const spec = literalSpec(importNode.source);
        if (spec === null || !CREATE_REQUIRE_SOURCES.has(spec)) continue;
        handledImports.add(importNode);
        if (id.type === "Identifier") {
            namespaces.add(scopes.declOf.get(id));
        } else if (id.type === "ObjectPattern") {
            for (const p of id.properties) {
                if (p.type === "RestElement") {
                    sites.push({ kind: "handed" });
                    continue;
                }
                const key = p.computed ? null : (p.key.name ?? p.key.value);
                if (key === "default") {
                    sites.push({ kind: "handed" }); // `default` re-exposes the module, not followed
                    continue;
                }
                if (key !== "createRequire") continue;
                const target = p.value.type === "AssignmentPattern" ? p.value.left : p.value;
                if (target.type === "Identifier") creators.add(scopes.declOf.get(target));
                else sites.push({ kind: "handed" });
            }
        } else {
            sites.push({ kind: "handed" });
        }
    }
    // Any other dynamic import of `module`: where its value goes is not followed.
    for (const imp of scopes.dynamicImports) {
        const spec = literalSpec(imp.source);
        if (spec !== null && CREATE_REQUIRE_SOURCES.has(spec) && !handledImports.has(imp)) {
            sites.push({ kind: "handed" });
        }
    }

    // `process.getBuiltinModule("node:module")` hands out the namespace without an
    // import: not followed, so reported (a computed specifier too).
    for (const call of scopes.builtinModuleCalls) {
        const spec = call.arguments.length >= 1 ? literalSpec(call.arguments[0]) : null;
        if (spec === null || CREATE_REQUIRE_SOURCES.has(spec)) sites.push({ kind: "handed" });
    }

    // `const c = e`: an alias of a tracked binding is tracked. Set iteration
    // visits entries added during the loop, so one pass reaches the end of a chain.
    const followAliases = (set) => {
        for (const binding of set) {
            for (const ref of binding.refs) {
                if (ref.role !== "read") continue;
                const parent = parents.get(ref.node);
                if (
                    parent?.type !== "VariableDeclarator" ||
                    parent.init !== ref.node ||
                    parent.id.type !== "Identifier"
                ) {
                    continue;
                }
                // `export const c = e` hands the alias to every importer.
                if (parents.get(parents.get(parent))?.type === "ExportNamedDeclaration") continue;
                const alias = scopes.declOf.get(parent.id);
                if (isSingleValue(alias) && !set.has(alias)) {
                    set.add(alias);
                    consumed.add(ref.node);
                }
            }
        }
    };
    followAliases(creators);
    followAliases(namespaces);

    // Every create call, with the callee text that names it.
    const createCalls = [];
    for (const binding of creators) {
        for (const ref of binding.refs) {
            if (consumed.has(ref.node)) continue;
            const parent = parents.get(ref.node);
            if (parent?.type === "CallExpression" && parent.callee === ref.node) {
                createCalls.push({ call: parent, name: binding.name });
            } else {
                sites.push({ kind: "handed" }); // copied, stored, passed, returned, exported
            }
        }
    }
    for (const binding of namespaces) {
        for (const ref of binding.refs) {
            if (consumed.has(ref.node)) continue;
            const member = parents.get(ref.node);
            if (
                member?.type !== "MemberExpression" ||
                member.object !== ref.node ||
                member.computed
            ) {
                sites.push({ kind: "handed" });
                continue;
            }
            const prop = member.property.name;
            if (prop === "createRequire") {
                const call = parents.get(member);
                if (call?.type === "CallExpression" && call.callee === member) {
                    createCalls.push({ call, name: `${binding.name}.createRequire` });
                } else {
                    sites.push({ kind: "handed" });
                }
            } else if (prop === "default") {
                sites.push({ kind: "handed" }); // a second namespace
            }
        }
    }

    let facts = null;
    const getFacts = () => {
        facts ??= bindingFacts(ast);
        return facts;
    };
    const checkedBindings = new Set();
    for (const { call, name } of createCalls) {
        const arg = call.arguments.length === 1 ? call.arguments[0] : null;
        if (arg !== null && isMetaUrlValue(arg, scopes)) {
            const site = classify(call, parents, getFacts);
            sites.push(site);
            if (!aliases.includes(name)) aliases.push(name);
            if (site.kind === "binding") {
                const holder = parents.get(call);
                const idNode =
                    holder?.type === "VariableDeclarator" ? holder.id : (holder?.left ?? null);
                const made = idNode ? bindingOf(idNode, scopes) : null;
                // Worklist: a require forwarded into another name (the bundler's
                // `__require` shim) is that name's require, checked the same way.
                let pending = made;
                while (pending !== null && !checkedBindings.has(pending)) {
                    checkedBindings.add(pending);
                    const target = forwardedTo(pending, parents, scopes, true);
                    if (target !== null) {
                        sites.push({ kind: "binding", name: target.name });
                        pending = bindingOf(target, scopes);
                    } else {
                        if (requireBindingEscapes(pending, parents, true)) {
                            sites.push({ kind: "handed" });
                        }
                        pending = null;
                    }
                }
            }
        } else if (call.arguments.some((a) => mayDeriveFromImportMeta(a, scopes))) {
            sites.push({ kind: "handed" }); // a wrapper, or an anchor derived from import.meta
        }
        else {
            // @getknext/lib anchors its ioredis load at a call-time `runtimeAnchor()`,
            // not `import.meta.url` (#2758): not embedded, but still named.
            const folded = runtimeAnchoredFold(call, parents, getFacts);
            if (folded !== null) {
                sites.push({ kind: "direct", dynamic: true, spec: null, folded });
            }
        }
        // Anything else is anchored somewhere other than this module (a literal,
        // the cwd): it was never embedded by this check and is not changed here.
    }
    for (const call of parents.keys()) {
        if (isWebpackFoldedLoad(call)) {
            sites.push({ kind: "direct", dynamic: true, spec: null, folded: FOLDED_RUNTIME_PACKAGE });
        }
    }
    return { aliases, sites, parseError: null };
}

/**
 * Whether `node` is the one anchor shape @getknext/lib uses instead of
 * `import.meta.url` (#2758): a call with no arguments (`runtimeAnchor()`, however a
 * bundler spells the callee). A literal, an identifier, or a call that takes
 * arguments is some other anchor and is not matched.
 */
function isRuntimeAnchorCall(node) {
    return node.type === "CallExpression" && node.arguments.length === 0;
}

/**
 * `FOLDED_RUNTIME_PACKAGE` when `call` is `create(runtimeAnchor())(SPEC)` with SPEC the
 * ioredis literal-join (directly or through a once-bound name), else null. The
 * rolldown / ESM counterpart of `isWebpackFoldedLoad`.
 */
function runtimeAnchoredFold(call, parents, getFacts) {
    if (call.arguments.length !== 1 || !isRuntimeAnchorCall(call.arguments[0])) return null;
    const parent = parents.get(call);
    if (parent?.type !== "CallExpression" || parent.callee !== call) return null;
    if (parent.arguments.length !== 1) return null;
    const arg = parent.arguments[0];
    if (literalSpec(arg) === FOLDED_RUNTIME_PACKAGE) return FOLDED_RUNTIME_PACKAGE;
    return foldSpecifier(arg, getFacts());
}

/**
 * The webpack standalone shape of the deliberate ioredis load (#2688).
 *
 * A webpack `next build` rewrites `import.meta.url` to a string literal URL
 * (`file:///<build path>/chunk.js`) and constant-folds the specifier, so
 * @getknext/lib's loader reaches the server chunks as
 * `(0, <ns>.createRequire)("file:///...")("ioredis")`. The creator there is an
 * external webpack module, not an ES import, so no alias or anchor is tracked
 * and `createRequire(import.meta.url)` never appears.
 *
 * Decision: match the SHAPE rather than follow webpack's module graph. A call
 * `C("file:...")("ioredis")` where `C` is `createRequire`, `<x>.createRequire`
 * or `(0, <x>.createRequire)`, with exactly one string-literal argument each,
 * is the same deliberate load the other targets name, so it is reported under
 * the same name-only exemption. It is deliberately narrow: another package, a
 * non-`file:` literal anchor, or an extra argument is not matched (the rest of the
 * literal-specifier cases stay with the scans that already own them).
 *
 * The anchor is either that `file:` literal (a lib built before #2758) or a
 * zero-argument call (`runtimeAnchor()`, which replaced `import.meta.url` so the
 * build path no longer reaches the chunk; see `isRuntimeAnchorCall`).
 */
function isWebpackFoldedLoad(call) {
    if (call.type !== "CallExpression" || call.arguments.length !== 1) return false;
    if (literalSpec(call.arguments[0]) !== FOLDED_RUNTIME_PACKAGE) return false;
    const create = call.callee;
    if (create.type !== "CallExpression" || create.arguments.length !== 1) return false;
    const url = literalSpec(create.arguments[0]);
    if (url === null ? !isRuntimeAnchorCall(create.arguments[0]) : !url.startsWith("file:")) {
        return false;
    }
    let callee = create.callee;
    if (callee.type === "SequenceExpression") callee = callee.expressions[callee.expressions.length - 1];
    if (callee.type === "Identifier") return callee.name === "createRequire";
    return (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        callee.property.name === "createRequire"
    );
}

/**
 * Whether an importing module does something with a require binding IMPORTED
 * from a sibling chunk (`import { n as __require } from "./rolldown-runtime.mjs"`)
 * other than call it. Its calls are followed by name across chunks; a copy, a
 * stored or passed value, or a re-export is not, so the package it loads would
 * be silently left out. An unparseable module is reported, never clean.
 *
 * @param {string} src
 * @param {string[]} names local names of the imported require bindings
 * @returns {{ escapes: boolean, parseError: string | null }}
 */
function analyzeImportedRequire(src, names) {
    if (names.length === 0) return { escapes: false, parseError: null };
    let ast;
    try {
        ast = parseSource(src);
    } catch (err) {
        return { escapes: true, parseError: String(err?.message ?? err) };
    }
    try {
        const parents = indexParents(ast);
        const scopes = buildScopes(ast);
        const wanted = new Set(names);
        for (const node of ast.body) {
            if (node.type !== "ImportDeclaration") continue;
            for (const spec of node.specifiers) {
                if (!wanted.has(spec.local.name)) continue;
                const binding = scopes.declOf.get(spec.local);
                if (binding && requireBindingEscapes(binding, parents, false)) {
                    return { escapes: true, parseError: null };
                }
            }
        }
        return { escapes: false, parseError: null };
    } catch (err) {
        return {
            escapes: true,
            parseError: `scope analysis failed: ${String(err?.message ?? err)}`,
        };
    }
}

// Script mode: `bun create-require-analyze.mjs < module.js` (the createRequire
// analysis), or `... --imported '["n"]' < module.js` (imported require bindings).
if (import.meta.main) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const src = Buffer.concat(chunks).toString("utf8");
    const flag = process.argv.indexOf("--imported");
    const result =
        flag === -1
            ? analyzeCreateRequire(src)
            : analyzeImportedRequire(src, JSON.parse(process.argv[flag + 1]));
    process.stdout.write(JSON.stringify(result));
}
