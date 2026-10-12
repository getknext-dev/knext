export async function getStaticProps() {
  return { props: {}, revalidate: 60 };
}
export default function Home() {
  return <p id="home">home</p>;
}
