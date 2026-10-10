// A second root layout: `/overlap/*` is its own root, beside `[locale]`.
export default function OverlapLayout({ children }) {
    return (
        <html>
            <body>{children}</body>
        </html>
    );
}
