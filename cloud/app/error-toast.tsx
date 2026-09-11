"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Small error-toast stack (V-T-lots-ux-round3, Will verbatim: "Dont'
 * show 'saved.' just save silently. Popup if there is an error."):
 * /lots used to show an inline green "Saved." on every successful
 * autosave — removed entirely. In its place, any autosave / clear-lot /
 * settings-menu request that FAILS now also raises a toast here (in
 * addition to the existing inline red row-error text, which still
 * flags the row itself) so a failure is impossible to miss without
 * cluttering the UI on the (overwhelmingly common) success path.
 *
 * No library — just a tiny hook (`useErrorToasts`) the page owns plus
 * this presentational stack. Toasts auto-dismiss after 8s or on ×;
 * multiple failures stack top-to-bottom.
 */

export type ToastMessage = { id: number; text: string };

const AUTO_DISMISS_MS = 8000;

let nextToastId = 1;

export function useErrorToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Reviewer follow-up (2026-09-11): pushError's 8s auto-dismiss timer
  // used to be a bare setTimeout with no handle kept anywhere — if the
  // user navigated away from /lots within 8s of a failure, the timer
  // still fired after unmount and called setToasts on an unmounted
  // hook (plus leaked the timer forever). Mirrors app/lots/page.tsx's
  // own autosave-timer cleanup: every pending timeout is tracked here,
  // by toast id, and cleared either when that toast is dismissed
  // (manually or by firing) or, for whatever's still pending, on
  // unmount.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, []);

  function pushError(text: string) {
    const id = nextToastId++;
    setToasts((prev) => [...prev, { id, text }]);
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
    timersRef.current.set(id, timer);
  }

  function dismiss(id: number) {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return { toasts, pushError, dismiss };
}

const styles = {
  wrap: {
    position: "fixed" as const,
    top: "1rem",
    right: "1rem",
    zIndex: 1000,
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
    maxWidth: 360,
  },
  toast: {
    background: "#3a1216",
    color: "#fff",
    border: "1px solid #b00020",
    borderRadius: 6,
    padding: "0.6rem 0.75rem",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    fontSize: "0.85rem",
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
  },
  text: { flex: "1 1 auto", wordBreak: "break-word" as const },
  close: {
    background: "none",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    fontSize: "1rem",
    lineHeight: 1,
    padding: 0,
  },
} as const;

export default function ErrorToast({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div style={styles.wrap} role="alert" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} style={styles.toast}>
          <span style={styles.text}>{t.text}</span>
          <button type="button" style={styles.close} onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
