import { readFileSync } from "node:fs";
import { join } from "node:path";
import { greeting } from "@fixture/shared";

export const dynamic = "force-dynamic";

// `note.txt` lives in the shared workspace package, OUTSIDE the app directory.
// It is read at request time from the standalone server's working directory,
// which is `.next/standalone/apps/web`, so the file only exists if the traced
// workspace file was packaged at `.next/standalone/packages/shared/note.txt`.
export default function Page() {
  const note = readFileSync(
    join(process.cwd(), "..", "..", "packages", "shared", "note.txt"),
    "utf8",
  ).trim();
  return (
    <main data-testid="home">
      {greeting()} | {note}
    </main>
  );
}
