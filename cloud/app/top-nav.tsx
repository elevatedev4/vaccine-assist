"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { buildNavItems, shouldShowNav } from "@/lib/nav-config";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, type SessionState } from "@/lib/supabase/session";

/**
 * Shared top tab strip (V-cloud-tabs) — rendered once, from the root
 * layout, so it appears on every AUTHENTICATED route. Plain <a> tags,
 * matching the rest of this app's existing style (no next/link usage
 * anywhere else in cloud/).
 *
 * MSG-895 (Will verbatim: "signin page shouldn't have anything visible
 * but the login form ... remove all the extra stuff (tabs)"): this used
 * to render unconditionally, so the tab bar sat above every page's own
 * sign-in gate. There is no separate /login route or shared auth
 * context in this app — each page (see app/appointments/page.tsx etc.)
 * independently tracks its own Supabase session and renders its own
 * inline sign-in form when signed out — so the structural fix lives
 * here: TopNav subscribes to the SAME session state every page already
 * does (subscribeToSessionState/getSupabaseBrowserClient — no new auth
 * logic, just an additional read-only listener) purely to decide
 * whether to render at all. `shouldShowNav` (lib/nav-config.ts) is the
 * pure, unit-tested predicate; this component is just the (untestable
 * without jsdom) wiring around it.
 *
 * MSG-899 (Will verbatim: "Move sign-out into an account dropdown at
 * the top right of the top bar ... plus anything account-ish that
 * already exists elsewhere — move it in"): every page used to render
 * its own identical "Signed in as X / Sign out" bar. That's gone from
 * every page now — this is the one place it lives. Sign-out here calls
 * the exact same `supabase.auth.signOut()` every page already called;
 * per supabase-js's GoTrueClient, that call clears the local session
 * (and fires onAuthStateChange -> SIGNED_OUT) in essentially every case
 * except a request that never reaches the network at all, so every
 * page's own subscribeToSessionState listener still picks up the
 * sign-out and resets its own local UI state — see each page's
 * `resetAfterSignOut` for what that clears. No auth-logic changes: this
 * is the same call, just triggered from one shared place instead of
 * seven duplicated buttons.
 */
const styles = {
  nav: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    padding: "0.5rem 1rem 0",
    borderBottom: "1px solid #ddd",
    background: "#fff",
    fontFamily: "system-ui, sans-serif",
  },
  tabs: { display: "flex", gap: "0.25rem", flex: "1 1 auto", minWidth: 0 },
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
  accountWrap: { position: "relative" as const, marginBottom: "0.5rem", flex: "0 0 auto" },
  accountTrigger: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    borderRadius: "50%",
    border: "1px solid #c7ccd1",
    background: "#eef2f7",
    color: "#0a58ca",
    fontSize: "0.8rem",
    fontWeight: 700,
    cursor: "pointer",
    padding: 0,
  },
  menu: {
    position: "absolute" as const,
    top: "calc(100% + 0.4rem)",
    right: 0,
    minWidth: 200,
    background: "#fff",
    border: "1px solid #ddd",
    borderRadius: 6,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
    padding: "0.5rem",
    zIndex: 20,
  },
  menuEmail: {
    padding: "0.3rem 0.5rem 0.5rem",
    fontSize: "0.8rem",
    color: "#555",
    borderBottom: "1px solid #eee",
    marginBottom: "0.35rem",
    wordBreak: "break-all" as const,
  },
  menuItem: {
    display: "block",
    width: "100%",
    textAlign: "left" as const,
    padding: "0.5rem",
    fontSize: "0.9rem",
    color: "#b00020",
    background: "none",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
  },
} as const;

function initialFor(email: string | null): string {
  const trimmed = (email ?? "").trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}

export default function TopNav() {
  const pathname = usePathname() ?? "/";
  const items = buildNavItems(pathname);

  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, (state) => {
        setSession(state);
        setAuthChecked(true);
      });
    } catch {
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Closes the account menu on any click/tap outside it, and on Escape —
  // standard menu behavior, listened for only while the menu is open.
  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  if (!shouldShowNav(authChecked, session !== null)) return null;

  async function handleSignOut() {
    setMenuOpen(false);
    try {
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
    } catch {
      // Every page's own session subscription still resolves this on its
      // own (see the doc comment above) — nothing else to do here.
    }
  }

  return (
    <nav style={styles.nav} aria-label="Primary">
      <div style={styles.tabs}>
        {items.map((item) => (
          <a key={item.href} href={item.href} style={item.active ? styles.linkActive : styles.link} aria-current={item.active ? "page" : undefined}>
            {item.label}
          </a>
        ))}
      </div>

      <div style={styles.accountWrap} ref={accountRef}>
        <button
          type="button"
          style={styles.accountTrigger}
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={session?.email ? `Account menu for ${session.email}` : "Account menu"}
        >
          {initialFor(session?.email ?? null)}
        </button>
        {menuOpen && (
          <div style={styles.menu} role="menu">
            <p style={styles.menuEmail}>Signed in as {session?.email ?? "unknown user"}</p>
            <button type="button" role="menuitem" style={styles.menuItem} onClick={() => void handleSignOut()}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
