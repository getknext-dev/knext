// Cluster C4 fixture route: `next/og`'s `ImageResponse` renders through
// `@vercel/og`, which reads `resvg.wasm` and its fallback font as siblings of
// its own module file (`new URL("./resvg.wasm", import.meta.url)` +
// `fs.readFileSync`). See entry-asset-anchor.mjs for why that breaks inside a
// `bun build --compile --bytecode` single executable without the fix this
// fixture exists to prove.
import { ImageResponse } from "next/og";

export const runtime = "nodejs";

export async function GET() {
    return new ImageResponse(
        (
            <div
                style={{
                    fontSize: 48,
                    background: "white",
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                }}
            >
                knext og fixture
            </div>
        ),
        { width: 600, height: 400 },
    );
}
