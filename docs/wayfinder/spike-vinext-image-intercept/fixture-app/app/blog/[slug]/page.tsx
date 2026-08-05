export const dynamic = 'force-dynamic';

export default async function Slug({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <main id="slug">SLUG:{slug}</main>;
}
