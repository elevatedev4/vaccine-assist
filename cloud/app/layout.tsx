import type { Metadata } from "next";
import type { ReactNode } from "react";
import TopNav from "@/app/top-nav";

export const metadata: Metadata = {
  title: "Vaccine Assist",
  description: "Pharmacy vaccine workflow app — cloud service.",
};

/**
 * Renders the shared top tab nav (V-cloud-tabs) above every route's own
 * content, so it's present regardless of that page's sign-in state.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TopNav />
        {children}
      </body>
    </html>
  );
}
