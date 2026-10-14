// The FFI e2e fixture page: renders one in-process Rust call at request time
// (a dynamic route — a call during `next build` prerendering is refused by the
// wrapper) and hosts the client component whose buttons call the Rust-backed
// Server Actions.

import { greet } from '@/generated/ffi';
import { FfiClient } from './ffi-client';

export const dynamic = 'force-dynamic';

function renderGreeting(): { ok: boolean; text: string } {
  try {
    return { ok: true, text: greet('page') };
  } catch (err) {
    // On a host without the library (the compat-smoke host-arch twin) the
    // page still renders; only the call fails.
    return { ok: false, text: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

export default function KnextFfiPage() {
  const greeting = renderGreeting();
  return (
    <main>
      <h1>In-process Rust (Beta)</h1>
      <p data-knext-ffi-render={greeting.ok ? 'ok' : 'error'}>{greeting.text}</p>
      <FfiClient />
    </main>
  );
}
