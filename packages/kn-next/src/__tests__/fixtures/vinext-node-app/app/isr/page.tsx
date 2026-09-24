// An ISR page: its origin Cache-Control carries shared-cache directives
// (`s-maxage=60, …`), which the deployed image must hand clients as
// `public, max-age=0, must-revalidate`.
export const revalidate = 60;

export default function IsrPage() {
    return <p>isr {new Date().toISOString()}</p>;
}
