"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, type SessionState } from "@/lib/supabase/session";
import { buildInstallOneLiner } from "@/lib/install-instructions";
import { copyToClipboard, CopyFallback } from "@/lib/macro-dose-button";

/**
 * /install tab (Will's brief verbatim: "Add install instructions for
 * powershell with a copy/paste for the code into an install tab on the
 * cloud") — the README.md:18-20 / bootstrap-fresh.ps1 fresh-install
 * one-liner, but built for THIS deployment (window.location.origin as
 * -ServerUrl, so it's always right regardless of which environment this
 * page is opened from) and, when a browser session exists, the signed-
 * in user's own email as -Email. -Password always stays the literal
 * placeholder — see lib/install-instructions.ts's doc comment.
 *
 * Deliberately NOT behind a sign-in gate: the whole point is a
 * fresh pharmacy PC with nothing installed and no existing browser
 * session can still load this page (from a link, bookmark, or typed
 * URL) and get a working command — it just falls back to the generic
 * placeholder email in that case, same as README.md always has.
 */

const COPIED_FLAG_MS = 1500;

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 720 },
  muted: { color: "#555", fontSize: "0.875rem" },
  section: { marginBottom: "2rem" },
  codeBlock: {
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.85rem",
    background: "#f4f4f4",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.75rem",
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    margin: 0,
  },
  codeRow: { display: "flex", alignItems: "flex-start", gap: "0.5rem", marginBottom: "0.35rem" },
  copyButton: { padding: "0.4rem 0.75rem", fontSize: "13px", flex: "0 0 auto" },
  note: { color: "#8a5300", fontSize: "0.8rem", marginTop: 0 },
  linkList: { paddingLeft: "1.25rem" },
} as const;

export default function InstallPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailure, setCopyFailure] = useState(false);

  useEffect(() => {
    setServerUrl(window.location.origin);
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, setSession);
    } catch {
      // Not signed in / not configured — the one-liner below just falls
      // back to the generic placeholder email, same as README.md.
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Nothing to copy/build yet on the very first render (serverUrl isn't
  // known until the effect above runs) — shows a disabled placeholder
  // instead of a wrong URL for one frame.
  const oneLiner = serverUrl ? buildInstallOneLiner({ serverUrl, email: session?.email ?? null }) : null;

  async function handleCopy() {
    if (!oneLiner) return;
    setCopyFailure(false);
    const ok = await copyToClipboard(oneLiner);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FLAG_MS);
    } else {
      setCopyFailure(true);
    }
  }

  return (
    <main style={styles.main}>
      <h1>Install the desktop app</h1>
      <p style={styles.muted}>
        Run this in PowerShell on the pharmacy PC. It installs what&apos;s needed, downloads the app, and puts a
        Vaccine Assist shortcut on the Desktop.
      </p>

      <section style={styles.section}>
        <div style={styles.codeRow}>
          <pre style={styles.codeBlock}>{oneLiner ?? "Loading…"}</pre>
          <button type="button" style={styles.copyButton} onClick={() => void handleCopy()} disabled={!oneLiner}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        {copyFailure && oneLiner && <CopyFallback code={oneLiner} />}
        <p style={styles.note}>
          Replace <code>the-shared-password</code> with the pharmacy&apos;s shared login password (keep the single
          quotes).
        </p>
      </section>

      <section style={styles.section}>
        <h2>What it does</h2>
        <ul style={styles.linkList}>
          <li>Installs Git and the .NET 8 SDK if they&apos;re not already on the PC.</li>
          <li>Downloads the app to <code>C:\Users\&lt;you&gt;\claude\vaccine-assist</code>.</li>
          <li>Creates the &quot;Vaccine Assist&quot; shortcut on the Desktop.</li>
          <li>Signs the app in with the email and password you passed.</li>
        </ul>
      </section>

      <section style={styles.section}>
        <h2>Already installed?</h2>
        <p>Click the Vaccine Assist shortcut — it updates and rebuilds the app every time.</p>
        <p style={styles.muted}>That shortcut just runs this, if you ever need to run it directly:</p>
        <pre style={styles.codeBlock}>
          powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\claude\vaccine-assist\desktop\update-and-run.ps1
        </pre>
      </section>

      <section style={styles.section}>
        <h2>Requirements</h2>
        <ul style={styles.linkList}>
          <li>Windows 10 or 11.</li>
          <li>Admin rights, for the first install only.</li>
          <li>Internet access.</li>
          <li>
            The WebView2 runtime — already on Windows 11. On Windows 10, install it from{" "}
            <a href="https://developer.microsoft.com/microsoft-edge/webview2/" target="_blank" rel="noreferrer">
              Microsoft&apos;s Evergreen link
            </a>
            .
          </li>
        </ul>
      </section>
    </main>
  );
}
