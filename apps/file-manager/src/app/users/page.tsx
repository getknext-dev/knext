import { getDbPool } from '@knative-next/lib';
import { revalidatePath, unstable_noStore } from 'next/cache';

async function getUsers() {
  unstable_noStore(); // Prevent static prerendering
  try {
    const db = getDbPool();
    const res = await db.query('SELECT * FROM users ORDER BY created_at DESC');
    return res.rows;
  } catch (error) {
    console.error('Error fetching users:', error);
    return [];
  }
}

async function addUser(formData: FormData) {
  'use server';
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;

  if (!name || !email) return;

  const db = getDbPool();
  await db.query('INSERT INTO users (name, email) VALUES ($1, $2)', [name, email]);
  revalidatePath('/users');
}

export default async function UsersPage() {
  const users = await getUsers();

  return (
    <div className="p-8 text-white">
      <h1 className="text-3xl font-bold mb-8">User Management</h1>

      <div className="grid md:grid-cols-3 gap-8">
        <div className="md:col-span-2">
          <div className="bg-white/5 rounded-xl overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-white/10">
                <tr>
                  <th className="p-4">Name</th>
                  <th className="p-4">Email</th>
                  <th className="p-4">Role</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user: any) => (
                  <tr key={user.id} className="border-t border-white/10">
                    <td className="p-4">{user.name}</td>
                    <td className="p-4">{user.email}</td>
                    <td className="p-4">
                      <span className="px-2 py-1 rounded bg-purple-500/20 text-purple-200 text-sm">
                        {user.role}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="bg-white/10 p-6 rounded-xl border border-white/20">
            <h3 className="text-xl font-bold mb-4">Add User</h3>
            <form action={addUser} className="space-y-4">
              <div>
                <label htmlFor="user-name" className="block text-sm mb-1">
                  Name
                </label>
                <input
                  id="user-name"
                  name="name"
                  type="text"
                  className="w-full p-2 rounded bg-black/20 border border-white/10"
                  required
                />
              </div>
              <div>
                <label htmlFor="user-email" className="block text-sm mb-1">
                  Email
                </label>
                <input
                  id="user-email"
                  name="email"
                  type="email"
                  className="w-full p-2 rounded bg-black/20 border border-white/10"
                  required
                />
              </div>
              <button
                type="submit"
                className="w-full bg-purple-600 hover:bg-purple-500 py-2 rounded font-bold"
              >
                Add User
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
