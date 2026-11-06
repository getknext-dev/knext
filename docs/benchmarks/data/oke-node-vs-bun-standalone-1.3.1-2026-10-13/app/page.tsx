// Bench page: force-dynamic SSR of a 50-row list after one loopback fetch
// (cache: 'no-store') to this app's own /api/items route.
export const dynamic = "force-dynamic";

type Item = { id: number; name: string };

export default async function Page() {
  const port = process.env.PORT || "3000";
  const res = await fetch(`http://127.0.0.1:${port}/api/items`, { cache: "no-store" });
  const { items } = (await res.json()) as { items: Item[] };
  return (
    <main>
      <h1>b131</h1>
      <p>items:{items.length}</p>
      <ul>
        {items.map((it) => (
          <li key={it.id}>{it.name}</li>
        ))}
      </ul>
    </main>
  );
}
