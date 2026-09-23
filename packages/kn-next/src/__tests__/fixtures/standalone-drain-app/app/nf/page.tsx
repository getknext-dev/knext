import { notFound } from "next/navigation";

/** `notFound()` must answer 404 from the compiled executable too. */
export const dynamic = "force-dynamic";

export default function Page() {
    notFound();
}
