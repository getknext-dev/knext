import { redirect } from "next/navigation";

// A prerendered (ISR) redirect: Next stores it as a page entry with tags and
// `s-maxage`, so the 3xx status is the only thing that keeps it off the edge.
export const revalidate = 3600;

export default function Moved() {
    redirect("/tagged");
}
