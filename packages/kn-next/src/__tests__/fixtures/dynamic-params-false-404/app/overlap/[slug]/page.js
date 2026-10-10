// A CLOSED matcher: only `known` is generated. Any other slug is rejected here
// and must fall through to the less specific `[...rest]` catch-all next door.
export const dynamicParams = false;

export function generateStaticParams() {
    return [{ slug: "known" }];
}

export default function SpecificPage() {
    return <p id="specific">Specific route</p>;
}
