// A Pages Router API route.
export default function handler(
    _req: unknown,
    res: { status(code: number): { json(body: unknown): void } },
) {
    res.status(200).json({ status: "ok", router: "pages" });
}
