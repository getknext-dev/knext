export default async function CatchAllPage({ params }) {
    const { rest } = await params;
    return <p id="catch-all">{rest.join("/")}</p>;
}
