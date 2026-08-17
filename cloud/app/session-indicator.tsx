"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, type SessionState } from "@/lib/supabase/session";

/**
 * Small dynamic session indicator for the root page. Extracted into its
 * own client component so the root page itself can stay a plain server
 * component — this is the only part of it that needs the browser
 * Supabase client.
 */
export default function SessionIndicator() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, (state) => {
        setSession(state);
        setAuthChecked(true);
      });
    } catch {
      // Supabase not configured yet (phase 1) — stay signed out.
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  if (!authChecked) return null;

  if (session) {
    return (
      <p>
        Signed in as <strong>{session.email ?? "unknown user"}</strong>
      </p>
    );
  }

  return (
    <p>
      Not signed in — <a href="/settings">sign in at Settings</a>
    </p>
  );
}
