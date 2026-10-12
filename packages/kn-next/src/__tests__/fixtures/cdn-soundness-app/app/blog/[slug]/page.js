export const revalidate = 60;
export function generateStaticParams() {
  return [{ slug: 'a' }];
}
export default async function Post({ params }) {
  const { slug } = await params;
  return <p id="post">{slug}</p>;
}
