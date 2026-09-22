export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main>
      <h1>spike home</h1>
      <p>rendered at {new Date().toISOString()}</p>
      <a href="/item/42">item 42</a>
    </main>
  );
}
