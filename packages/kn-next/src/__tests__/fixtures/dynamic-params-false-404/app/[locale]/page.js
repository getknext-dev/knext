export default async function LocalePage({ params }) {
    const { locale } = await params;
    return <div id="locale-page">Locale: {locale}</div>;
}
