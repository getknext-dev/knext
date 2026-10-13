// An ordinary ISR page; next.config.mjs adds a Set-Cookie to it.
export const revalidate = 3600;

export default function CookiePage() {
    return <main>COOKIE-BODY</main>;
}
