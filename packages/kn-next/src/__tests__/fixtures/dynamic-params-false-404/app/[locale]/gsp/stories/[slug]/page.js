// Only `static-123` is prerendered; the route inherits `dynamicParams = false`
// from the root layout, so any other slug (and any non-listed locale) is a 404.
export async function generateStaticParams() {
    return [{ slug: "static-123" }];
}

export default async function StoryPage({ params }) {
    const { locale, slug } = await params;
    return (
        <div id="story-page">
            <div id="story-locale">Locale: {locale}</div>
            <div id="story-slug">Story: {slug}</div>
        </div>
    );
}
