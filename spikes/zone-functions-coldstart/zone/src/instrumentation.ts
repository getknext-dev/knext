export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { wakeAhead } = await import('./lib/wake');
  wakeAhead();
}
