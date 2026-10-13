import { connection } from "next/server";

// Shallow readiness: no I/O, never a prerendered (cached) 200.
export async function GET() {
    await connection();
    return Response.json({ status: "ok" });
}
