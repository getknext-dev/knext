export async function getStaticPaths() {
  return { paths: [{ params: { slug: 'a' } }], fallback: 'blocking' };
}
export async function getStaticProps({ params }) {
  return { props: { slug: params.slug }, revalidate: 60 };
}
export default function Post({ slug }) {
  return <p id="post">{slug}</p>;
}
