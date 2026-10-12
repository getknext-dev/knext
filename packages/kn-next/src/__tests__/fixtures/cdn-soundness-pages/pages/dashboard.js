export async function getStaticProps() {
  return { props: { secret: 'protected' }, revalidate: 3600 };
}
export default function Dashboard({ secret }) {
  return <p id="dashboard">{secret}</p>;
}
