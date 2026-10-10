import { draftMode } from 'next/headers';

// Prerendered at build time; Draft Mode bypasses the prerender.
export default async function Article() {
  const { isEnabled } = await draftMode();
  return <p id="article">{isEnabled ? 'Draft article one' : 'Published article one'}</p>;
}
