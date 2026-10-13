// Statically rendered, behind the cookie-checking proxy (proxy.ts).
export const dynamic = "force-static";

export default function ProtectedStatic() {
    return <main>PROTECTED-BODY</main>;
}
