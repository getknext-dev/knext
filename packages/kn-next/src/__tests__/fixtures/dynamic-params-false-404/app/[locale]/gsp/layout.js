// A layout with a PARALLEL ROUTE slot (`@breadcrumbs`) beside `children`.
export default function GspLayout({ children, breadcrumbs }) {
    return (
        <>
            <div id="breadcrumbs">{breadcrumbs}</div>
            <main id="main">{children}</main>
        </>
    );
}
