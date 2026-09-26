/**
 * The `// @knext-shim <id>` marker scan (#1450).
 *
 * SCANS the shim tree rather than enumerating files: a new shim file is found
 * because it carries a marker, and a marker that does not parse is an error,
 * never a skip — a typo'd marker must not silently drop a shim out of the
 * retirement check.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const MARKER_TOKEN = '@knext-shim';
/** The only accepted form: a whole line, `// @knext-shim <kebab-id>`. */
const MARKER_LINE = /^\s*\/\/ @knext-shim ([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/;
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

export type Marker = { id: string; file: string; line: number };
export type ScanResult = { markers: Marker[]; malformed: string[] };

/** Every marker under `root` (recursive, `__tests__` and `node_modules` excluded). */
export function scanMarkers(root: string, base: string = root): ScanResult {
  const markers: Marker[] = [];
  const malformed: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(path);
        continue;
      }
      if (!SOURCE.test(entry.name)) continue;
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((text, i) => {
        if (!text.includes(MARKER_TOKEN)) return;
        const m = MARKER_LINE.exec(text);
        const where = `${relative(base, path)}:${i + 1}`;
        if (m) markers.push({ id: m[1], file: relative(base, path), line: i + 1 });
        else malformed.push(`${where}: ${text.trim()}`);
      });
    }
  };
  walk(root);
  return { markers, malformed };
}

/** Marker ids with no registry entry, and registry ids with no marker. */
export function crossCheck(
  markers: Marker[],
  registryIds: string[],
): { orphanMarkers: string[]; unmarkedEntries: string[] } {
  const known = new Set(registryIds);
  const marked = new Set(markers.map((m) => m.id));
  return {
    orphanMarkers: markers
      .filter((m) => !known.has(m.id))
      .map((m) => `${m.file}:${m.line} (${m.id})`),
    unmarkedEntries: registryIds.filter((id) => !marked.has(id)),
  };
}
