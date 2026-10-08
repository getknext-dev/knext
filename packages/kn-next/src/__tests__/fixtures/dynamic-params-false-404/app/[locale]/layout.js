// Root layout with a ROOT PARAM (`[locale]`) and `dynamicParams = false`: a
// locale outside `generateStaticParams` must 404 rather than render.
export function generateStaticParams() {
    return [{ locale: "en" }, { locale: "fr" }];
}

export const dynamicParams = false;

export default function RootLayout({ children }) {
    return (
        <html>
            <body>{children}</body>
        </html>
    );
}
