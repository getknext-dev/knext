// getStaticPaths with fallback:false: `a` is prerendered (200), any other slug
// is a 404 — the Pages Router twin of the app-router dynamicParams=false case.
export async function getStaticPaths() {
  return { paths: [{ params: { slug: 'a' } }], fallback: false };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug }, revalidate: 60 };
}

export default function Post({ slug }: { slug: string }) {
  return <main>p-{slug}</main>;
}
