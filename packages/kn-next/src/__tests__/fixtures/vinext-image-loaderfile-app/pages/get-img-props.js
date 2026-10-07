import { getImageProps } from 'next/image';

export default function Page() {
  const { props } = getImageProps({
    id: 'optimized',
    alt: 'optimized',
    src: '/optimize/logo.png',
    width: 400,
    height: 400,
    priority: true,
  });
  return (
    <div>
      <p>hello-get-img-props</p>
      <img {...props} />
    </div>
  );
}
