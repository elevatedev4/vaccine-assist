import type { Metadata } from "next";
import type { ReactNode } from "react";
import TopNav from "@/app/top-nav";
import DesktopHandoffBootstrap from "@/app/desktop-handoff-bootstrap";

export const metadata: Metadata = {
  title: "Vaccine Assist",
  description: "Pharmacy vaccine workflow app — cloud service.",
};

/**
 * Renders the shared top tab nav (V-cloud-tabs) above every route's own
 * content, so it's present regardless of that page's sign-in state.
 *
 * DesktopHandoffBootstrap (renders nothing) runs on every route for the
 * same reason — it's how a fresh WebView2 page load picks up the session
 * the desktop app just handed off via
 * app/api/auth/desktop-handoff/route.ts. See that component's doc
 * comment.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DesktopHandoffBootstrap />
        <TopNav />
        {children}
      </body>
    </html>
  );
}
