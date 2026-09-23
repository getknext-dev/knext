// A SERVER-EXTERNAL dependency (next.config `serverExternalPackages`), so it is
// NOT bundled into the page chunk: the chunk `require`s it from disk at request
// time. It reaches Next's router context through `next/router`, whose
// `router-context.shared-runtime` request is REDIRECTED by Next's require-hook
// (`Module.prototype.require`) to the pages runtime's vendored copy — the only
// thing that lets it see the RouterContext the pages runtime provides. If that
// redirect is lost, or the context module is split into two instances,
// `useRouter()` throws "NextRouter was not mounted" and the page is a 500.
const React = require('react');
const { useRouter } = require('next/router');

exports.RouteProbe = function RouteProbe() {
  const router = useRouter();
  const [n] = React.useState(7);
  return React.createElement('p', null, `ext-route-${router.pathname}-${n}`);
};
