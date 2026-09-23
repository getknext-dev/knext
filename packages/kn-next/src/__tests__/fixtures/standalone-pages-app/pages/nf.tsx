// getServerSideProps returning `notFound: true` must answer 404, not 500.
export async function getServerSideProps() {
  return { notFound: true };
}

export default function NotFoundPage() {
  return <main>never rendered</main>;
}
