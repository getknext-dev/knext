// Renders the server-external `knext-ext-probe` component (see ext-probe/).
import { RouteProbe } from 'knext-ext-probe';

export async function getServerSideProps() {
  return { props: {} };
}

export default function Ext() {
  return (
    <main>
      <RouteProbe />
    </main>
  );
}
