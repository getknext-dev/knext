// The shallow health route the image's compile-cache bake warms (it needs no
// database, so `docker build` can boot the server).
export const dynamic = "force-dynamic";

export function GET() {
    return Response.json({ status: "ok" });
}
