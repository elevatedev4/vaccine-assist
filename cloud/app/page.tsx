import { redirect } from "next/navigation";

/**
 * Home (/) has no content of its own (V-cloud-tabs, Will 2026-09-05: "a
 * single site with tabs") — it immediately redirects to the Schedule tab,
 * the app's default landing page.
 */
export default function HomePage(): never {
  redirect("/appointments");
}
