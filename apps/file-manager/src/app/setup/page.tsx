import TokenField from '@/components/TokenField';
import { runSetup } from './actions';

/**
 * Database setup. A GET only RENDERS: it never touches the database. Creating the
 * tables and seeding data is the `runSetup` Server Action (a POST that needs the
 * admin token), so a crawler, a prefetch or a cross-site request cannot trigger it.
 */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const done = params.done === '1';
  const failed = params.failed === '1';

  return (
    <div className="p-8 text-white">
      <h1 className="text-3xl font-bold mb-4">Database Setup</h1>

      {done && (
        <div className="p-4 rounded bg-green-800">
          <p>Database initialized successfully</p>
          <p className="mt-2">Tables created: files, users, audit_logs</p>
          <p>Seeded initial data.</p>
        </div>
      )}
      {failed && (
        <div className="p-4 rounded bg-red-800">
          Database setup failed. See the server logs for the cause.
        </div>
      )}

      <form action={runSetup} className="mt-4 max-w-sm space-y-4">
        <p className="text-purple-200">
          Creates the demo tables and seeds them if they are empty. Safe to run again.
        </p>
        <TokenField id="setup-token" />
        <button
          type="submit"
          className="w-full bg-purple-600 hover:bg-purple-500 py-2 rounded font-bold"
        >
          Initialize database
        </button>
      </form>
    </div>
  );
}
