// A `revalidate: false` page that prints the build that rendered it: never
// revalidated by time, so after a rollout only the cache handler's
// previous-build handling can make the new build render its own copy.
export const revalidate = false;

export default function StaticMark() {
    return (
        <main>
            <h1>static-mark</h1>
            <p id="build">{process.env.KNEXT_E2E_BUILD_MARK}</p>
        </main>
    );
}
