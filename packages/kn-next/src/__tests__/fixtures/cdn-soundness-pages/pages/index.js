export async function getStaticProps() {
  return { props: {}, revalidate: 3600 };
}
export default function Home() {
  return <p id="home">home</p>;
}
