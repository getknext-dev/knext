export const dynamic = 'force-dynamic';

export default async function Item({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main>
      <h1>item {id}</h1>
      <p>dynamic route rendered at {new Date().toISOString()}</p>
    </main>
  );
}
