// Images under /optimize/ stay on the default image optimizer, written the way
// Next.js's loader-config-default-loader-with-file fixture writes it (a
// trailing-slash /_next/image/ URL with a raw, unencoded src). Everything else
// goes to a CDN.
export default function customLoader({ src, width, quality }) {
  if (src.startsWith('/optimize/')) {
    return `/_next/image/?url=${src}&w=${width}&q=${quality || 50}`;
  }
  return `https://cdn.knext-loaderfile.test${src}?w=${width}&q=${quality ?? 'auto'}`;
}
