import { unstable_cache } from 'next/cache';

// An ISR page whose entry carries an explicit tag (`posts`, from the cached
// data it reads) next to its implicit `_N_T_` path tags. The CDN seam guard
// asserts both reach the response's Cache-Tag through the real cache handler.
export const revalidate = 3600;

const posts = unstable_cache(async () => ['first post'], ['seam-alive-posts'], { tags: ['posts'] });

export default async function Tagged() {
  const list = await posts();
  return <p id="posts">{list.join(',')}</p>;
}
