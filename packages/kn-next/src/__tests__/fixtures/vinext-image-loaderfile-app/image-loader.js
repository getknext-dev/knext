export default function customLoader({ src, width, quality }) {
  return `https://cdn.knext-loaderfile.test${src}?w=${width}&q=${quality ?? 'auto'}`;
}
