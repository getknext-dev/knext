import { listMessages } from '@/db/queries';
import { postMessage } from './actions';

// Always render fresh — this is a database-backed guestbook, not a static page.
export const dynamic = 'force-dynamic';

/**
 * The read path: a server component that lists messages on the **read-only**
 * gateway (`getDbRO()`, bounded-stale). The `<form>` posts to a server action
 * that writes on the **writer** (`getDb()`). One page proves both halves of the
 * `@knext/db` read/write split, both waking their scale-to-zero compute on the
 * first request.
 */
export default async function Home() {
  const messages = await listMessages();

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>db-demo — @knext/db guestbook</h1>
      <p>
        Reads run on the RO gateway (<code>getDbRO()</code>, bounded-stale); the form writes on the
        single writer (<code>getDb()</code>). Both wake from zero on the first request.
      </p>

      <form action={postMessage} style={{ display: 'grid', gap: 8, margin: '1.5rem 0' }}>
        <input name="author" placeholder="your name" aria-label="author" />
        <textarea name="body" placeholder="leave a message" aria-label="message" required />
        <button type="submit">Post</button>
      </form>

      <ul>
        {messages.map((m) => (
          <li key={m.id}>
            <strong>{m.author}</strong>: {m.body}{' '}
            <em style={{ color: '#888' }}>({m.createdAt.toISOString()})</em>
          </li>
        ))}
        {messages.length === 0 && <li>No messages yet — be the first.</li>}
      </ul>
    </main>
  );
}
