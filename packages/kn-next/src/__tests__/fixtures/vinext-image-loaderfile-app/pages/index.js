import Image from 'next/image';

export default function Home() {
  return (
    <div>
      <p>hello-loaderfile</p>
      <Image src="/photo.png" alt="a photo" width={100} height={50} />
    </div>
  );
}
