/**
 * `dynamicParams = false`: an unknown slug must answer 404. Next maps it by
 * IDENTITY (`err instanceof NoFallbackError`, a `*.external` singleton shared
 * between the server core and the route chunk) — so this route is how the
 * compiled-executable e2e proves the executable holds ONE copy of that module
 * (a second, bundled copy answers 500 "Internal: NoFallbackError").
 */
export const dynamicParams = false;

export function generateStaticParams() {
    return [{ slug: "a" }];
}

export default async function Page({
    params,
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    return <main data-testid="p">p-{slug}</main>;
}
