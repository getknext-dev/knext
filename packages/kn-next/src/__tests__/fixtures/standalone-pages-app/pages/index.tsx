// getServerSideProps: a Pages Router SSR render on every request.
export async function getServerSideProps() {
  return { props: { rendered: 'gssp-ok' } };
}

export default function Home({ rendered }: { rendered: string }) {
  return <main>home {rendered}</main>;
}
