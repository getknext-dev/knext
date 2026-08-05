// A DYNAMIC App-Router page. It exists to prove that dynamic segments and param
// binding survive `bun build --compile --bytecode` — the compiled binary has no
// filesystem route table to fall back on, so a dynamic segment is exactly the
// shape most likely to break when routes are embedded rather than read from
// `.output/server/` at runtime.
export const dynamic = 'force-dynamic';

export default async function Item({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1 data-testid="item-id">item:{id}</h1>
    </main>
  );
}
