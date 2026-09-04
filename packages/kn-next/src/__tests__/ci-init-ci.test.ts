/**
 * ADR-0049 — what `kn-next init-ci` generates (#874).
 *
 * The generated files are the entire client-facing surface of stage 1: a
 * workflow they will read, and an RBAC manifest they will `kubectl apply`
 * without necessarily understanding every line. So the properties asserted here
 * are the ones a reader would have to check by hand and mostly will not.
 *
 * Structural assertions go through a YAML parser rather than string matching.
 * A manifest that "contains the right text" and does not parse is still a
 * manifest nobody can apply, and grepping for `- delete` cannot tell a verb
 * from a comment.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import { classifyCredentialScope } from "../cli/ci/credential-scope";
import {
    initCi,
    RBAC_PATH,
    REQUIRED_SECRETS,
    renderRbacManifest,
    renderWorkflow,
    WORKFLOW_PATH,
} from "../cli/ci/init-ci";

const rbacDocs = (ns: string) =>
    parseAllDocuments(renderRbacManifest(ns)).map((d) => d.toJS());

describe("the generated RBAC manifest (#874)", () => {
    it("parses as three documents: ServiceAccount, Role, RoleBinding", () => {
        const kinds = rbacDocs("acme").map((d) => d.kind);
        expect(kinds).toEqual(["ServiceAccount", "Role", "RoleBinding"]);
    });

    it("is namespaced throughout — no cluster-scoped object anywhere", () => {
        // A ClusterRole here would silently widen the grant to every namespace,
        // and it is the single easiest mistake to make in an RBAC generator
        // because ClusterRole/Role differ by one word.
        for (const doc of rbacDocs("acme")) {
            expect(doc.kind).not.toMatch(/^Cluster/);
            expect(doc.metadata.namespace).toBe("acme");
        }
        expect(rbacDocs("acme")[2].roleRef.kind).toBe("Role");
    });

    it("grants nothing but nextapps, and never delete", () => {
        const role = rbacDocs("acme")[1];
        expect(role.rules).toHaveLength(1);
        expect(role.rules[0].apiGroups).toEqual(["apps.kn-next.dev"]);
        expect(role.rules[0].resources).toEqual(["nextapps"]);
        expect(role.rules[0].verbs).not.toContain("delete");
        expect(role.rules[0].verbs).not.toContain("*");
    });

    it("binds the Role to the ServiceAccount it also creates", () => {
        // A RoleBinding pointing at a subject that does not exist applies
        // cleanly and grants nothing, so the failure surfaces much later as an
        // unexplained 403 during a deploy.
        const [sa, , binding] = rbacDocs("acme");
        expect(binding.subjects).toHaveLength(1);
        expect(binding.subjects[0].name).toBe(sa.metadata.name);
        expect(binding.subjects[0].kind).toBe("ServiceAccount");
        expect(binding.roleRef.name).toBe(rbacDocs("acme")[1].metadata.name);
    });

    it("generates a credential its OWN preflight accepts", () => {
        // The end-to-end property. If the generator and the classifier drift,
        // every client hits a refusal on the credential knext told them to
        // create — and the natural fix, in a hurry, is to widen the Role.
        const role = rbacDocs("acme")[1];
        expect(classifyCredentialScope(role.rules).ok).toBe(true);
    });
});

describe("the generated workflow (#874)", () => {
    const wf = () => parse(renderWorkflow("."));

    it("parses, and runs one deploy job", () => {
        expect(Object.keys(wf().jobs)).toEqual(["deploy"]);
    });

    it("takes no write permission it does not need", () => {
        // `contents: write` on a deploy workflow would let a compromised step
        // push to the repository. The deploy credential is the kubeconfig
        // secret, not the GitHub token.
        expect(wf().permissions.contents).toBe("read");
        expect(wf().permissions["id-token"]).toBeUndefined();
    });

    it("serialises deploys per ref rather than cancelling them", () => {
        // Two concurrent applies of the same resource race, and the loser
        // silently wins on the next reconcile — so the cluster ends up running
        // whichever build finished second, not whichever commit is newer.
        // cancel-in-progress would abort a deploy mid-apply instead.
        const c = wf().concurrency;
        expect(c["cancel-in-progress"]).toBe(false);
        expect(c.group).toContain("github.ref");
    });

    it("documents every secret it asks for, and why", () => {
        // A user who cannot see why a permission is wanted cannot consent to
        // it. Scanned from the one list, so adding a secret without a reason
        // fails rather than shipping an undocumented ask.
        const text = renderWorkflow(".");
        for (const s of REQUIRED_SECRETS) {
            expect(text).toContain(s.name);
            expect(text).toContain(s.why);
        }
    });

    it("passes secrets by reference, never inlining a value", () => {
        const text = renderWorkflow(".");
        for (const s of REQUIRED_SECRETS) {
            if (s.name === "KNEXT_REGISTRY_TOKEN") continue; // has a fallback
            expect(text).toContain(`secrets.${s.name}`);
        }
    });
});

describe("initCi writes both files (#874)", () => {
    const scratch = () => mkdtempSync(join(tmpdir(), "knext-initci-"));

    it("writes the workflow and the RBAC manifest", () => {
        const root = scratch();
        const r = initCi(root, { namespace: "acme", appDir: "." });
        expect(r.written.sort()).toEqual([RBAC_PATH, WORKFLOW_PATH].sort());
        expect(existsSync(join(root, WORKFLOW_PATH))).toBe(true);
        expect(existsSync(join(root, RBAC_PATH))).toBe(true);
    });

    it("refuses to clobber an edited workflow, and says so", () => {
        // The client will have edited this file. A generator that overwrites it
        // to "help" is one you cannot safely re-run, which means nobody re-runs
        // it and the RBAC never gets regenerated either.
        const root = scratch();
        initCi(root, { namespace: "acme", appDir: "." });
        writeFileSync(join(root, WORKFLOW_PATH), "# edited by hand\n");
        const again = initCi(root, { namespace: "acme", appDir: "." });
        expect(again.skipped).toContain(WORKFLOW_PATH);
        expect(readFileSync(join(root, WORKFLOW_PATH), "utf8")).toBe(
            "# edited by hand\n",
        );
    });

    it("overwrites only when explicitly forced", () => {
        const root = scratch();
        initCi(root, { namespace: "acme", appDir: "." });
        writeFileSync(join(root, WORKFLOW_PATH), "# edited\n");
        const forced = initCi(root, {
            namespace: "acme",
            appDir: ".",
            force: true,
        });
        expect(forced.written).toContain(WORKFLOW_PATH);
        expect(readFileSync(join(root, WORKFLOW_PATH), "utf8")).toContain(
            "knext",
        );
    });

    it("carries the namespace into the manifest it writes, not just the args", () => {
        const root = scratch();
        initCi(root, { namespace: "prod-eu", appDir: "apps/web" });
        const docs = parseAllDocuments(
            readFileSync(join(root, RBAC_PATH), "utf8"),
        ).map((d) => d.toJS());
        expect(docs.every((d) => d.metadata.namespace === "prod-eu")).toBe(
            true,
        );
        expect(
            parse(readFileSync(join(root, WORKFLOW_PATH), "utf8")).jobs.deploy
                .steps[1].with["working-directory"],
        ).toBe("apps/web");
    });
});
