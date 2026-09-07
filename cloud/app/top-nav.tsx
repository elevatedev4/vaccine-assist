"use client";

import { usePathname } from "next/navigation";
import { buildNavItems } from "@/lib/nav-config";

/**
 * Shared top tab strip (V-cloud-tabs) — rendered once, from the root
 * layout, so it appears on every route including the sign-in gate each
 * page still shows for itself. Plain <a> tags, matching the rest of this
 * app's existing style (no next/link usage anywhere else in cloud/).
 */
const styles = {
  nav: {
    display: "flex",
    gap: "0.25rem",
    padding: "0.5rem 1rem 0",
    borderBottom: "1px solid #ddd",
    background: "#fff",
    fontFamily: "system-ui, sans-serif",
  },
  link: {
    display: "inline-block",
    padding: "0.6rem 1rem",
    color: "#333",
    textDecoration: "none",
    borderBottom: "3px solid transparent",
    fontSize: "0.9rem",
  },
  linkActive: {
    display: "inline-block",
    padding: "0.6rem 1rem",
    color: "#0a58ca",
    textDecoration: "none",
    borderBottom: "3px solid #0a58ca",
    fontWeight: 600,
    fontSize: "0.9rem",
  },
} as const;

export default function TopNav() {
  const pathname = usePathname() ?? "/";
  const items = buildNavItems(pathname);

  return (
    <nav style={styles.nav} aria-label="Primary">
      {items.map((item) => (
        <a key={item.href} href={item.href} style={item.active ? styles.linkActive : styles.link} aria-current={item.active ? "page" : undefined}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
