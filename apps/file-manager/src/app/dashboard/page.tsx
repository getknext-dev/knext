import { getDbPool } from '@knative-next/lib';
import { unstable_noStore } from 'next/cache';

async function getStats() {
  unstable_noStore(); // Prevent static prerendering
  try {
    const db = getDbPool();

    const fileStats = await db.query(
      'SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total_size FROM files',
    );
    const userStats = await db.query('SELECT COUNT(*) as count FROM users');
    const recentFiles = await db.query('SELECT * FROM files ORDER BY uploaded_at DESC LIMIT 5');

    return {
      fileCount: fileStats.rows[0].count,
      totalSize: fileStats.rows[0].total_size,
      userCount: userStats.rows[0].count,
      recentFiles: recentFiles.rows,
    };
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    return { fileCount: 0, totalSize: 0, userCount: 0, recentFiles: [] };
  }
}

export default async function DashboardPage() {
  const stats = await getStats();

  return (
    <div className="p-8 text-white">
      <h1 className="text-3xl font-bold mb-8">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white/10 p-6 rounded-xl border border-white/20">
          <h3 className="text-xl text-purple-200">Total Files</h3>
          <p className="text-4xl font-bold">{stats.fileCount}</p>
        </div>
        <div className="bg-white/10 p-6 rounded-xl border border-white/20">
          <h3 className="text-xl text-purple-200">Storage Used</h3>
          <p className="text-4xl font-bold">{(stats.totalSize / 1024 / 1024).toFixed(2)} MB</p>
        </div>
        <div className="bg-white/10 p-6 rounded-xl border border-white/20">
          <h3 className="text-xl text-purple-200">Total Users</h3>
          <p className="text-4xl font-bold">{stats.userCount}</p>
        </div>
      </div>

      <h2 className="text-2xl font-bold mb-4">Recent Uploads</h2>
      <div className="bg-white/5 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-white/10">
            <tr>
              <th className="p-4">Name</th>
              <th className="p-4">Size</th>
              <th className="p-4">Date</th>
            </tr>
          </thead>
          <tbody>
            {stats.recentFiles.map((file: any) => (
              <tr key={file.id} className="border-t border-white/10">
                <td className="p-4">{file.name}</td>
                <td className="p-4">{(file.size / 1024).toFixed(1)} KB</td>
                <td className="p-4">{new Date(file.uploaded_at).toLocaleString()}</td>
              </tr>
            ))}
            {stats.recentFiles.length === 0 && (
              <tr>
                <td colSpan={3} className="p-4 text-center text-gray-400">
                  No files uploaded yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
