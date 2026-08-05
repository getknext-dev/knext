export const dynamic = 'force-dynamic';

export default function Home() {
  return <main id="ssr">SSR-OK {Date.now()}</main>;
}
