/**
 * Child-process harness for the vinext#3768 behaviour tests in
 * vinext-patches.test.ts. It drives the REAL patched app-router-scroll module
 * (a React class component) and scroll-intent state inside a happy-dom tree and
 * prints the outcome as JSON.
 *
 * It runs in its own process, not in the test's, because the test file also
 * builds apps with vite under NODE_ENV=production: React picks its development
 * or production build once per process, and a jsx-runtime from one with a
 * react-dom from the other throws, so the DOM scenarios need a process of their
 * own with a fixed NODE_ENV.
 *
 * happy-dom does no layout, so a route element's rect is modelled as
 * `documentTop - scrollY`, and scrollTop / scrollIntoView move scrollY.
 *
 * Usage: bun vinext-scroll-harness.ts <patched vinext dir> <options JSON>
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";

export type HarnessOptions = {
    /**
     * Route elements in DOM order. documentTop null = no box (display: none);
     * viewportTop pins the rect to the viewport (position: fixed with a top).
     */
    route: {
        id: string;
        documentTop: number | null;
        viewportTop?: number;
    }[];
    scrollY: number;
    claim?: { parallelSlotOwned?: boolean };
    hash?: string | null;
    padding?: string;
    /** Render a precedence <style> first, which React hoists into <head>. */
    hoistedStyleFirst?: boolean;
};

export type HarnessOutcome = {
    activeElementId: string;
    pendingIntent: Record<string, unknown> | null;
    scrollY: number;
};

/** Just the React surface the harness uses (the helper is not DOM-typed). */
type ReactLike = {
    createElement: (
        type: unknown,
        props: unknown,
        ...children: unknown[]
    ) => unknown;
    act: (callback: () => Promise<void> | void) => Promise<void>;
};

type ScrollState = {
    beginAppRouterScrollIntent: (hash: string | null) => unknown;
    claimAppRouterScrollIntentForCommit: (
        intent: unknown,
        commitId: number,
        claim?: { parallelSlotOwned?: boolean },
    ) => void;
    clearAppRouterScrollIntent: () => void;
    getPendingAppRouterScrollIntent: () => Record<string, unknown> | null;
};

type ScrollModule = {
    AppRouterScrollCommitProvider: unknown;
    AppRouterScrollTarget: unknown;
};

async function main(): Promise<HarnessOutcome> {
    const patched = process.argv[2];
    const options = JSON.parse(process.argv[3]) as HarnessOptions;
    const load = async <T>(rel: string) =>
        (await import(pathToFileURL(join(patched, rel)).href)) as T;

    // React must be the copy the patched module resolves.
    const req = createRequire(join(patched, "package.json"));
    const React = req("react") as ReactLike;
    const { createRoot } = req("react-dom/client") as {
        createRoot: (host: unknown) => {
            render: (tree: unknown) => void;
            unmount: () => void;
        };
    };

    const win = new Window({ url: "http://localhost/" });
    const w = win as unknown as Record<string, unknown>;
    const g = globalThis as Record<string, unknown>;
    for (const n of ["document", "Element", "HTMLElement", "Text"]) g[n] = w[n];
    g.window = win;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.getComputedStyle = () => ({
        scrollPaddingTop: options.padding ?? "0px",
    });

    let scrollY = options.scrollY;
    const html = win.document.documentElement;
    Object.defineProperty(html, "clientHeight", { value: 800 });
    Object.defineProperty(html, "scrollTop", {
        configurable: true,
        get: () => scrollY,
        set: (v: number) => {
            scrollY = v;
        },
    });
    const specOf = (node: { id: string }) =>
        options.route.find((r) => r.id === node.id);
    Object.defineProperty(win.HTMLElement.prototype, "getClientRects", {
        value(this: { id: string }) {
            const spec = specOf(this);
            if (spec?.viewportTop !== undefined)
                return [{ top: spec.viewportTop }];
            const top = spec?.documentTop;
            return top === null || top === undefined
                ? []
                : [{ top: top - scrollY }];
        },
    });
    Object.defineProperty(win.HTMLElement.prototype, "scrollIntoView", {
        value(this: { id: string }) {
            const top = specOf(this)?.documentTop;
            if (top !== null && top !== undefined) scrollY = top;
        },
    });

    // The element the user clicked: outside the route, focused before the
    // navigation.
    const link = win.document.createElement("button");
    link.id = "clicked-link";
    win.document.body.appendChild(link);
    link.focus();
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);

    const state = await load<ScrollState>(
        "dist/shims/app-router-scroll-state.js",
    );
    const scroll = await load<ScrollModule>("dist/shims/app-router-scroll.js");
    const intent = state.beginAppRouterScrollIntent(options.hash ?? null);
    state.claimAppRouterScrollIntentForCommit(intent, 1, options.claim);

    const children: unknown[] = options.route.map((spec) =>
        React.createElement("div", { key: spec.id, id: spec.id }),
    );
    if (options.hoistedStyleFirst) {
        children.unshift(
            React.createElement("style", {
                key: "hoisted",
                href: "custom-stylesheet",
                precedence: "alpha",
            }),
        );
    }
    const root = createRoot(host);
    await React.act(async () => {
        root.render(
            React.createElement(
                scroll.AppRouterScrollCommitProvider as never,
                { commitId: 1 },
                React.createElement(
                    scroll.AppRouterScrollTarget as never,
                    null,
                    ...children,
                ),
            ),
        );
    });
    await React.act(async () => {
        await Promise.resolve();
    });

    const outcome: HarnessOutcome = {
        activeElementId: (
            win.document.activeElement as unknown as { id: string }
        ).id,
        pendingIntent: state.getPendingAppRouterScrollIntent(),
        scrollY,
    };
    await React.act(async () => root.unmount());
    return outcome;
}

main().then(
    (outcome) => {
        process.stdout.write(`${JSON.stringify(outcome)}\n`);
        process.exit(0);
    },
    (err) => {
        process.stderr.write(
            `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
        process.exit(1);
    },
);
