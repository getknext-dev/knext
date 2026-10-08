export default async function BreadcrumbsStoryPage({ params }) {
    const { locale, slug } = await params;
    return (
        <div id="breadcrumbs-story">
            Breadcrumbs: {locale} / {slug}
        </div>
    );
}
