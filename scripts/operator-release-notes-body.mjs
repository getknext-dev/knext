#!/usr/bin/env node
/**
 * The generated body of an `operator-vX.Y.Z[-rc.N]` GitHub release (#2153).
 *
 * `operator-supply-chain.yml` attaches the digest-pinned `install.yaml` to a release
 * on the pushed operator tag; the body used to be empty unless someone wrote it by
 * hand. It now states, for THIS tag:
 *
 *   - the install command;
 *   - the operator image digest, READ from the attached `install.yaml`;
 *   - that cert-manager is required, when (and only when) the bundle carries a
 *     cert-manager `Certificate`;
 *   - the CRD API version, read from the bundle's NextApp CRD;
 *   - the upgrade order: operator and CRD first, then the CLI.
 *
 * Everything about the bundle is read from the bundle, never typed, so the notes
 * cannot disagree with the asset beside them.
 *
 * The parse is line-based, not a YAML parse, because the publishing job has no
 * install step (`tests/workflow-script-install-guard.test.ts`). It reads only
 * kustomize-rendered, controller-gen shaped output, and fails closed (exit 1) when it
 * cannot find what it must state.
 *
 * Usage:
 *   node scripts/operator-release-notes-body.mjs --tag <operator-vX.Y.Z[-pre]> \
 *        --repo <owner/repo> --install <install.yaml> --out <file>
 * Appends `path=<out>` to $GITHUB_OUTPUT when set.
 * Exit 0 = ok. Exit 1 = refused (nothing written). Exit 2 = usage.
 *
 * Node builtins only.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRD_NAME = 'nextapps.apps.kn-next.dev';
const OPERATOR_TAG = /^operator-v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const PINNED_IMAGE = /^\s*(?:-\s+)?image:\s*(\S*kn-next-operator\S*@sha256:[0-9a-f]{64})\s*$/;

function topLevel(doc, key) {
  const m = new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm').exec(doc);
  return m ? m[1] : null;
}

/** Version items of the CRD: `{ name, served, storage }[]`, from the `versions:` list. */
function crdVersions(doc) {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => /^ {2}versions:\s*$/.test(l));
  if (start === -1) return [];
  const items = [];
  let itemIndent = null;
  let keyIndent = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (itemIndent === null) {
      if (!line.trimStart().startsWith('- ')) break;
      itemIndent = indent;
      keyIndent = indent + 2;
    }
    if (indent < itemIndent || (indent === itemIndent && !line.trimStart().startsWith('- '))) break;
    let content = null;
    if (indent === itemIndent && line.trimStart().startsWith('- ')) {
      items.push({ name: null, served: false, storage: false });
      content = line.trimStart().slice(2);
    } else if (indent === keyIndent) {
      content = line.trimStart();
    }
    if (content === null || items.length === 0) continue;
    const cur = items[items.length - 1];
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(content);
    if (!kv) continue;
    if (kv[1] === 'name') cur.name = kv[2].trim();
    else if (kv[1] === 'served') cur.served = kv[2].trim() === 'true';
    else if (kv[1] === 'storage') cur.storage = kv[2].trim() === 'true';
  }
  return items.filter((i) => i.name !== null);
}

/**
 * @param {string} text the attached install.yaml
 */
export function parseInstallYaml(text) {
  const docs = text.split(/^---\s*$/m);

  const crd = docs.find(
    (d) =>
      topLevel(d, 'kind') === 'CustomResourceDefinition' &&
      new RegExp(`^ {2}name:\\s*${CRD_NAME.replaceAll('.', '\\.')}\\s*$`, 'm').test(d),
  );
  if (!crd) throw new Error(`install.yaml has no ${CRD_NAME} CustomResourceDefinition`);
  const group = /^ {2}group:\s*(\S+)\s*$/m.exec(crd)?.[1];
  if (!group) throw new Error(`the ${CRD_NAME} CRD has no spec.group`);
  const versions = crdVersions(crd).filter((v) => v.served);
  const chosen = versions.find((v) => v.storage) ?? versions[0];
  if (!chosen) throw new Error(`the ${CRD_NAME} CRD has no served version`);

  const images = new Set();
  for (const d of docs) {
    if (topLevel(d, 'kind') !== 'Deployment') continue;
    for (const line of d.split('\n')) {
      const m = PINNED_IMAGE.exec(line);
      if (m) images.add(m[1]);
    }
  }
  if (images.size === 0) {
    throw new Error(
      'install.yaml has no digest-pinned kn-next-operator image (image: …@sha256:<64 hex>)',
    );
  }
  if (images.size > 1) {
    throw new Error(
      `install.yaml pins more than one distinct operator image: ${[...images].join(', ')}`,
    );
  }

  const certManager = docs.some(
    (d) => /^apiVersion:\s*cert-manager\.io\//m.test(d) && topLevel(d, 'kind') === 'Certificate',
  );
  const webhook = docs.some((d) => topLevel(d, 'kind') === 'ValidatingWebhookConfiguration');

  return {
    image: [...images][0],
    crdName: CRD_NAME,
    apiVersion: `${group}/${chosen.name}`,
    certManager,
    webhook,
  };
}

/**
 * @param {{ tag: string, repo: string, info: ReturnType<typeof parseInstallYaml> }} input
 */
export function buildOperatorBody({ tag, repo, info }) {
  const m = OPERATOR_TAG.exec(tag);
  if (!m) throw new Error(`tag ${JSON.stringify(tag)} is not operator-vX.Y.Z[-prerelease]`);
  const line = `${m[1]}.${m[2]}`;
  const installs = [
    `\`install.yaml\` installs the \`${info.crdName}\` CRD, the operator Deployment, its RBAC`,
    info.webhook ? ' and its validating webhook.' : '.',
  ].join('');
  const certManager = info.certManager
    ? " The webhook's certificate is issued by cert-manager, so **cert-manager must already be installed** in the cluster."
    : '';
  return [
    `The knext operator release for the **knext v${line}** line. The operator reconciles \`NextApp\` resources (\`${info.apiVersion}\`) into Knative Services, and it is the single source of truth for cluster state: the knext CLI only builds, publishes and applies a \`NextApp\`.`,
    '',
    '## Install',
    '',
    '```sh',
    `kubectl apply -f https://github.com/${repo}/releases/download/${tag}/install.yaml`,
    '```',
    '',
    `${installs}${certManager} The operator image is pinned by digest:`,
    '',
    '```',
    info.image,
    '```',
    '',
    '## Compatibility',
    '',
    `- CRD API version: \`${info.apiVersion}\`.`,
    `- Pairs with \`@getknext/core\` ${line}.x. See the [compatibility matrix](https://github.com/${repo}/blob/${tag}/docs/COMPATIBILITY.md).`,
    '- **Upgrade order:** upgrade the operator and CRD first, then the CLI. An older operator rejects fields a newer CLI emits.',
    '',
  ].join('\n');
}

class UsageError extends Error {}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--tag', '--repo', '--install', '--out'].includes(flag)) {
      throw new UsageError(`unknown argument ${flag}`);
    }
    if (argv[i + 1] === undefined) throw new UsageError(`${flag} needs a value`);
    args[flag.slice(2)] = argv[i + 1];
  }
  for (const required of ['tag', 'repo', 'install', 'out']) {
    if (!args[required]) throw new UsageError(`--${required} is required`);
  }
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`operator-release-notes-body: ${err.message}`);
    return 2;
  }
  try {
    const info = parseInstallYaml(readFileSync(args.install, 'utf8'));
    const body = buildOperatorBody({ tag: args.tag, repo: args.repo, info });
    writeFileSync(args.out, body);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `path=${args.out}\n`);
    console.log(`wrote ${args.out}`);
    return 0;
  } catch (err) {
    console.error(`operator-release-notes-body: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
