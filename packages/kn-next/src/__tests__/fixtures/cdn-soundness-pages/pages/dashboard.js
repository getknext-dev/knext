export async function getStaticProps() {
  return { props: { secret: 'protected' }, revalidate: 60 };
}
export default function Dashboard({ secret }) {
  return <p id="dashboard">{secret}</p>;
}
