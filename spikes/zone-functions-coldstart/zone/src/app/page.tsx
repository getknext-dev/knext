import { pingAction } from './actions';

export const dynamic = 'force-dynamic';

export default function Page() {
  async function run(formData: FormData) {
    'use server';
    await pingAction(String(formData.get('fn') || 'fn-go-h1'));
  }
  return (
    <main>
      <h1>Z2 zone</h1>
      <form action={run}>
        <input name="fn" defaultValue="fn-go-h1" />
        <button type="submit">ping</button>
      </form>
    </main>
  );
}
