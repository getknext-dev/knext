import { connection } from "next/server";

// Never cached anywhere: the build this pod is running, for the rollout case to
// compare a cached page's build mark against.
export default async function Build() {
    await connection();
    return <p id="build">{process.env.KNEXT_E2E_BUILD_MARK}</p>;
}
