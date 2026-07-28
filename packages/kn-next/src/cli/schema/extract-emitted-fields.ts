/**
 * extract-emitted-fields.ts — the set of NextApp CR field paths this CLI can
 * emit, DERIVED BY SCANNING `cli/cr-builder.ts` rather than enumerated.
 *
 * BUILD-TIME / TEST-TIME ONLY. This module imports the TypeScript compiler and
 * must never enter the shipped CLI bundle: the runtime consumers (the prune
 * preflight, `doctor`'s schema-coverage check) import the GENERATED artifact
 * `emitted-fields.generated.ts` instead, which `scripts/gen-cr-fields.ts`
 * produces from this scanner and CI re-derives.
 *
 * Why scan at all (T5): a hand-written field list goes stale silently the first
 * time somebody adds a knob to the builder — which is precisely the silent-skew
 * failure the preflight exists to remove, reintroduced one layer up. Enumerating
 * is also how the `preview deploy` apply site was missed once already.
 *
 * PATH GRAMMAR
 *   `spec.database.roSecretRef.name`  — a literal key at each level
 *   `spec.env`                        — a leaf whose value is opaque (a map)
 *   `spec.secrets.envMap.*.secretName`— `*` = a dynamic key or an array index
 *
 * WHAT THE WALKER UNDERSTANDS (everything else must FAIL the coverage guard in
 * cr-emitted-fields-extractor.test.ts, never silently shrink the set):
 *   - object literals, incl. shorthand properties
 *   - `const` identifiers declared in the same function (resolved to their
 *     initializer); `let`/reassignment is deliberately NOT followed
 *   - conditional spreads `...(cond ? { k: v } : {})`, `?? {}`, `&&`/`||`
 *   - unresolved calls (`.map(...)`, `Object.fromEntries(...)`): the outermost
 *     object literals inside the call are walked one `*` segment deeper
 */

import ts from "typescript";

/** A literal key found inside a function body, with its 1-based line. */
export interface LiteralKey {
    name: string;
    line: number;
}

function parse(source: string): ts.SourceFile {
    return ts.createSourceFile(
        "cr-builder.ts",
        source,
        ts.ScriptTarget.ES2022,
        /* setParentNodes */ true,
        ts.ScriptKind.TS,
    );
}

function findFunction(
    sf: ts.SourceFile,
    name: string,
): ts.FunctionDeclaration | undefined {
    let found: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
            found = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
}

function propertyName(
    node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): string | undefined {
    if (ts.isShorthandPropertyAssignment(node)) return node.name.text;
    const n = node.name;
    if (ts.isIdentifier(n)) return n.text;
    if (ts.isStringLiteral(n)) return n.text;
    if (
        ts.isComputedPropertyName(n) &&
        ts.isStringLiteralLike(n.expression) &&
        // A computed key that is a plain string literal is still a literal key.
        true
    ) {
        return n.expression.text;
    }
    return undefined;
}

/**
 * Every literal object key inside `functionName`'s body, in source order.
 *
 * This is the COUNTING half of the anti-vacuity guard: the walker below
 * understands a fixed set of constructs, so anything it cannot reach must show
 * up here as a key with no corresponding path and fail the guard, rather than
 * disappearing from the emitted set.
 */
export function objectLiteralKeys(
    source: string,
    functionName: string,
): LiteralKey[] {
    const sf = parse(source);
    const fn = findFunction(sf, functionName);
    if (!fn?.body) return [];
    const out: LiteralKey[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node)
        ) {
            const name = propertyName(node);
            if (name !== undefined) {
                out.push({
                    name,
                    line:
                        sf.getLineAndCharacterOfPosition(node.getStart(sf))
                            .line + 1,
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return out;
}

/** `const` initializers declared anywhere in the function body. */
function constInitializers(
    fn: ts.FunctionDeclaration,
): Map<string, ts.Expression> {
    const out = new Map<string, ts.Expression>();
    const visit = (node: ts.Node): void => {
        if (ts.isVariableStatement(node)) {
            const isConst =
                (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
            if (isConst) {
                for (const d of node.declarationList.declarations) {
                    if (ts.isIdentifier(d.name) && d.initializer) {
                        out.set(d.name.text, d.initializer);
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    return out;
}

function unwrap(node: ts.Expression): ts.Expression {
    let n: ts.Expression = node;
    for (;;) {
        if (ts.isParenthesizedExpression(n)) {
            n = n.expression;
            continue;
        }
        if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) {
            n = n.expression;
            continue;
        }
        if (ts.isNonNullExpression(n)) {
            n = n.expression;
            continue;
        }
        return n;
    }
}

/**
 * Outermost object literals in a subtree — i.e. literals not contained in
 * another literal from the same subtree. Used for calls the walker cannot
 * resolve (`.map(w => ({…}))`, `Object.fromEntries(…)`), whose literals become
 * entries one `*` segment deeper.
 */
function outermostObjectLiterals(node: ts.Node): ts.ObjectLiteralExpression[] {
    const out: ts.ObjectLiteralExpression[] = [];
    const visit = (n: ts.Node): void => {
        if (ts.isObjectLiteralExpression(n)) {
            out.push(n);
            return; // do not descend — nested literals belong to this one
        }
        ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    return out;
}

class Walker {
    private readonly paths = new Set<string>();
    private readonly consts: Map<string, ts.Expression>;
    /** Guards against a `const a = b; const b = a;` cycle. */
    private readonly seen = new Set<ts.Node>();

    constructor(fn: ts.FunctionDeclaration) {
        this.consts = constInitializers(fn);
    }

    result(): string[] {
        return [...this.paths].sort();
    }

    /** Walk `expr` as the value living at `path` ("" = the CR root). */
    walk(expr: ts.Expression, path: string): void {
        const node = unwrap(expr);
        if (this.seen.has(node)) return;
        this.seen.add(node);
        try {
            this.walkInner(node, path);
        } finally {
            this.seen.delete(node);
        }
    }

    private emit(path: string): void {
        if (path) this.paths.add(path);
    }

    private child(path: string, key: string): string {
        return path ? `${path}.${key}` : key;
    }

    private walkInner(node: ts.Expression, path: string): void {
        if (ts.isObjectLiteralExpression(node)) {
            for (const prop of node.properties) {
                if (ts.isSpreadAssignment(prop)) {
                    this.walk(prop.expression, path);
                    continue;
                }
                const name =
                    ts.isPropertyAssignment(prop) ||
                    ts.isShorthandPropertyAssignment(prop)
                        ? propertyName(prop)
                        : undefined;
                if (name === undefined) continue;
                const childPath = this.child(path, name);
                this.emit(childPath);
                const value = ts.isPropertyAssignment(prop)
                    ? prop.initializer
                    : (prop as ts.ShorthandPropertyAssignment).name;
                this.walk(value, childPath);
            }
            return;
        }

        if (ts.isIdentifier(node)) {
            const init = this.consts.get(node.text);
            if (init) this.walk(init, path);
            return;
        }

        if (ts.isConditionalExpression(node)) {
            this.walk(node.whenTrue, path);
            this.walk(node.whenFalse, path);
            return;
        }

        if (ts.isBinaryExpression(node)) {
            const op = node.operatorToken.kind;
            if (
                op === ts.SyntaxKind.QuestionQuestionToken ||
                op === ts.SyntaxKind.AmpersandAmpersandToken ||
                op === ts.SyntaxKind.BarBarToken
            ) {
                this.walk(node.left, path);
                this.walk(node.right, path);
            }
            return;
        }

        if (ts.isArrayLiteralExpression(node)) {
            for (const el of node.elements) {
                if (ts.isSpreadElement(el)) this.walk(el.expression, path);
                else this.walk(el, path);
            }
            return;
        }

        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
                this.walk(node.body, path);
            }
            return;
        }

        if (ts.isCallExpression(node)) {
            // A call the walker cannot evaluate. Its object literals describe
            // the ELEMENTS of a dynamic map / array, so they sit one `*` deeper.
            const literals = outermostObjectLiterals(node);
            for (const lit of literals) {
                this.walk(lit, this.child(path, "*"));
            }
            return;
        }

        // Anything else (property access, literal, template, `undefined`, …)
        // is an opaque leaf; the path itself was already emitted by the caller.
    }
}

/**
 * All CR field paths `buildNextAppCRObject` can emit, sorted.
 *
 * @param source - the text of `cli/cr-builder.ts`
 */
export function extractEmittedFields(source: string): string[] {
    const sf = parse(source);
    const fn = findFunction(sf, "buildNextAppCRObject");
    if (!fn?.body) {
        throw new Error(
            "cr-builder.ts: buildNextAppCRObject not found — the emitted-field scanner has nothing to scan (renamed? moved? then update the scanner, do not delete it)",
        );
    }
    const walker = new Walker(fn);
    let returned = 0;
    const visit = (node: ts.Node): void => {
        if (ts.isReturnStatement(node) && node.expression) {
            returned++;
            walker.walk(node.expression, "");
        }
        ts.forEachChild(node, visit);
    };
    visit(fn.body);
    if (returned === 0) {
        throw new Error(
            "cr-builder.ts: buildNextAppCRObject has no return statement the scanner could find",
        );
    }
    return walker.result();
}
