"use client";

import { useEffect } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { DESKTOP_HANDOFF_COOKIE_NAME, parseDesktopSessionMessage, shouldApplyPushedSession } from "@/lib/desktop-handoff";

/**
 * Client half of the desktop -> embedded-WebView2 session handoff — see
 * app/api/auth/desktop-handoff/route.ts's doc comment for the full
 * picture. That route validates the desktop's tokens and leaves them in a
 * short-lived cookie; this component (mounted once from the root layout,
 * so it runs on every route including "/") reads that cookie on mount,
 * calls the SAME browser client every interactive sign-in uses to
 * establish the session (auth.setSession), and clears the cookie
 * immediately — success or failure, and regardless of which page happened
 * to be first to mount after the redirect.
 *
 * It also listens for the desktop's pushed session refreshes (WebView2
 * web messages): the desktop owns the only real refresh token and posts a
 * fresh access token here each time it refreshes — see
 * parseDesktopSessionMessage in lib/desktop-handoff.ts for why. Outside
 * the desktop app `window.chrome.webview` doesn't exist and this is a
 * no-op.
 *
 * Renders nothing. Never throws, never logs the token values themselves.
 */
type WebViewHost = {
  addEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
};

export default function DesktopHandoffBootstrap() {
  useEffect(() => {
    const webview = (window as unknown as { chrome?: { webview?: WebViewHost } }).chrome?.webview;
    if (!webview) return;

    const onMessage = (event: { data: unknown }) => {
      const session = parseDesktopSessionMessage(event.data);
      if (!session) return;
      void (async () => {
        try {
          const supabase = getSupabaseBrowserClient();
          // Skip a push that carries the token we already hold: setSession
          // would notify every subscriber with SIGNED_IN and make each
          // page reload its data (spinner flash, edit forms reset).
          const { data } = await supabase.auth.getSession();
          if (!shouldApplyPushedSession(data.session?.access_token, session.access_token)) return;
          await supabase.auth.setSession(session);
        } catch {
          // A failed push just leaves the page on its previous session;
          // the next push (or the page's own sign-in gate) recovers.
        }
      })();
    };

    webview.addEventListener("message", onMessage);
    return () => webview.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const raw = readCookie(DESKTOP_HANDOFF_COOKIE_NAME);
    if (!raw) return;

    // Clear immediately — this is a one-shot cookie; a failed setSession
    // below should not keep retrying on every subsequent page load.
    clearCookie(DESKTOP_HANDOFF_COOKIE_NAME);

    try {
      const parsed = JSON.parse(raw) as { access_token?: unknown; refresh_token?: unknown };
      if (typeof parsed.access_token !== "string" || typeof parsed.refresh_token !== "string") {
        return;
      }

      const supabase = getSupabaseBrowserClient();
      void supabase.auth.setSession({
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
      });
    } catch {
      // Malformed cookie value or Supabase not configured — the page's
      // own sign-in gate is the fallback; nothing else to do here.
    }
  }, []);

  return null;
}

function readCookie(name: string): string | null {
  const match = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${name}=`));
  if (!match) return null;
  const value = match.slice(name.length + 1);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clearCookie(name: string): void {
  document.cookie = `${name}=; Max-Age=0; path=/`;
}
