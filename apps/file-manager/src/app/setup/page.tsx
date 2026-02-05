import { getDbPool } from '@knative-next/lib';
import { unstable_noStore } from 'next/cache';

async function setupDatabase() {
  unstable_noStore(); // Prevent static prerendering
  const db = getDbPool();

  try {
    // Create files table
    await db.query(`
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        mime_type TEXT,
        storage_path TEXT,
        uploaded_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add missing columns if table exists (migration)
    await db.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS mime_type TEXT;`).catch(() => {});
    await db.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_path TEXT;`).catch(() => {});

    // Create users table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT DEFAULT 'user',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create audit_logs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Seed some data if empty
    const userCount = await db.query('SELECT COUNT(*) FROM users');
    if (Number.parseInt(userCount.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO users (name, email, role) VALUES 
        ('Admin User', 'admin@example.com', 'admin'),
        ('John Doe', 'john@example.com', 'user'),
        ('Jane Smith', 'jane@example.com', 'editor')
        ON CONFLICT (email) DO NOTHING;
      `);
    }

    // Seed audit logs
    const auditCount = await db.query('SELECT COUNT(*) FROM audit_logs');
    if (Number.parseInt(auditCount.rows[0].count) === 0) {
      // Generate 1000 dummy logs
      const values = Array.from(
        { length: 1000 },
        (_, i) => `('LOGIN', 'User logged in session ${i}', NOW() - INTERVAL '${i} minutes')`,
      ).join(',');
      await db.query(`INSERT INTO audit_logs (action, details, created_at) VALUES ${values}`);
    }

    return { success: true, message: 'Database initialized successfully' };
  } catch (error: any) {
    console.error('Setup failed:', error);
    return { success: false, message: error.message };
  }
}

export default async function SetupPage() {
  const result = await setupDatabase();

  return (
    <div className="p-8 text-white">
      <h1 className="text-3xl font-bold mb-4">Database Setup</h1>
      <div className={`p-4 rounded ${result.success ? 'bg-green-800' : 'bg-red-800'}`}>
        {result.message}
      </div>
      <div className="mt-4">
        <p>Tables created: files, users, audit_logs</p>
        <p>Seeded initial data.</p>
      </div>
    </div>
  );
}
