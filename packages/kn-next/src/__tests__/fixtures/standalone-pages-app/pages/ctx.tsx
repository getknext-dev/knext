// Module-IDENTITY probe for the Pages Router. Every import below reaches a
// React context or the React dispatcher that the pages runtime PROVIDES and
// this page CONSUMES:
//   - useState      -> the React dispatcher (two `react` copies = "Invalid hook call");
//   - useRouter     -> RouterContext (a second router-context copy = null router,
//                      which Next turns into "NextRouter was not mounted");
//   - next/head     -> HeadManagerContext (a split drops the <title>);
//   - next/link     -> RouterContext again, on the client-component path.
// A split in any of them is a 500 or a missing marker, never a silent pass.
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

export async function getServerSideProps() {
  return { props: {} };
}

export default function Ctx() {
  const [n] = useState(41);
  const router = useRouter();
  return (
    <main>
      <Head>
        <title>knext-head-ok</title>
      </Head>
      <p>{`state-${n + 1}`}</p>
      <p>{`route-${router.pathname}`}</p>
      <Link href="/p/a">link-ok</Link>
    </main>
  );
}
