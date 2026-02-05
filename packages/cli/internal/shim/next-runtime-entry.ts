// Next.js Server Runtime Entry Point
// This will be bundled and loaded dynamically by bootstrap.ts

// Import Next.js server
import { startServer } from 'next/dist/server/lib/start-server';

export async function start() {
  const port = Number.parseInt(process.env.PORT || '8080');
  const hostname = process.env.HOSTNAME || '0.0.0.0';

  console.log('[Runtime] Starting Next.js server...');

  try {
    await startServer({
      dir: process.cwd(),
      hostname,
      port,
      dev: false,
      customServer: false,
    });

    console.log(`[Runtime] ✅ Next.js server ready on ${hostname}:${port}`);
  } catch (error) {
    console.error('[Runtime] Failed to start:', error);
    throw error;
  }
}

// Auto-start if loaded directly
if (import.meta.main) {
  start();
}
