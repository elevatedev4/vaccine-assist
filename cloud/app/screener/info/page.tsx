"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import { CONDITION_ITEMS, SCREENER_RULES } from "@/lib/screener-rules";
import { describeRules, type DescribedTier, type DescribedVaccine } from "@/lib/screener-info";
import { vaccineDisplayName } from "@/lib/vaccine-display-name";

/**
 * Screener info page (companion to app/screener/page.tsx — Will
 * 2026-09-13 verbatim: "Add an info page to be able to see the list of
 * all conditions/age ranges for each vaccine too."). Same client-page
 * shell (SignInGate + subscribeToSessionState + AuthLoading) as the
 * screener itself, but this page has no form/state of its own — it's a
 * static reference rendering of the same SCREENER_RULES data the
 * screener evaluates, run through lib/screener-info.ts's pure
 * `describeRules` and grouped into cards.
 *
 * Deliberately reads SCREENER_RULES/CONDITION_ITEMS only — never edits
 * lib/screener-rules.ts or lib/screener.ts, whose rule data is being
 * re-researched separately. Because this page derives everything from
 * that data rather than hardcoding vaccine specifics, it renders
 * whatever the rules say without needing its own changes when they're
 * updated.
 */

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "1rem 1.5rem 3rem", fontSize: "0.78rem" },
  backLink: { margin: "0 0 0.5rem", fontSize: "0.78rem" },
  heading: { margin: "0.25rem 0 0.25rem", fontSize: "1.25rem" },
  note: {
    margin: "0 0 1.25rem",
    padding: "0.5rem 0.75rem",
    background: "#eef6ff",
    border: "1px solid #cfe3fb",
    borderRadius: 6,
    color: "#1a4971",
    fontSize: "0.72rem",
  },
  card: {
    border: "1px solid #d5dce3",
    borderRadius: 8,
    background: "#fff",
    padding: "0.75rem 0.9rem",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.55rem",
  },
  cardName: { margin: 0, fontSize: "0.9rem" },
  section: { display: "flex", flexDirection: "column" as const, gap: "0.25rem" },
  sectionLabel: {
    margin: 0,
    fontSize: "0.68rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.03em",
    color: "#555",
  },
  tierLine: { display: "flex", flexDirection: "column" as const, gap: "0.05rem" },
  tierMain: { fontSize: "0.75rem", color: "#222" },
  conditionsList: {
    margin: "0.1rem 0 0.15rem",
    paddingLeft: "1.1rem",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.05rem",
  },
  conditionItem: { fontSize: "0.7rem", color: "#222" },
  tierReason: { fontSize: "0.7rem", color: "#666" },
  sources: { marginTop: "0.15rem", display: "flex", flexDirection: "column" as const, gap: "0.1rem" },
  sourceLink: { fontSize: "0.68rem", color: "#1a6ecf" },
} as const;

/** Section key -> heading, in display order. Only sections with at
 * least one tier are rendered per card (see `sections` below). */
const SECTIONS: { key: keyof Pick<
  DescribedVaccine,
  "routine" | "conditionBased" | "consider" | "caution" | "notIndicated" | "info"
>; label: string }[] = [
  { key: "routine", label: "Routine" },
  { key: "conditionBased", label: "Because of conditions" },
  { key: "consider", label: "Consider / discuss" },
  { key: "caution", label: "Caution" },
  { key: "notIndicated", label: "Not indicated" },
  { key: "info", label: "Needs a question we don't ask" },
];

// Static across the life of the page — SCREENER_RULES/CONDITION_ITEMS
// don't change at runtime, so this only needs to be computed once.
const DESCRIBED_VACCINES = describeRules(SCREENER_RULES, CONDITION_ITEMS);

/** "ages 50–74" / "Any age" / "ages 50+" — the conditions (if any) render
 * as a separate bulleted list below this line. */
function tierAgeText(tier: DescribedTier): string {
  return tier.ageRangeText === "any age" ? "Any age" : `ages ${tier.ageRangeText}`;
}

function sourceLinkLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function ScreenerInfoPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

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

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setSignInError(null);
    setSigningIn(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: signInEmail,
        password: signInPassword,
      });
      if (error || !data.session) {
        setSignInError(error?.message ?? "Sign-in failed.");
        return;
      }
      setSession(toSessionState(data.session));
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSigningIn(false);
    }
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to view the screener's full rule list."
        email={signInEmail}
        password={signInPassword}
        onEmailChange={setSignInEmail}
        onPasswordChange={setSignInPassword}
        onSubmit={handleSignIn}
        error={signInError}
        submitting={signingIn}
      />
    );
  }

  return (
    <main style={styles.main} className="screener-info-main">
      <style>{`
        .screener-info-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          gap: 0.9rem;
        }
        @media print {
          [data-top-nav] { display: none !important; }
          .screener-info-back-link { display: none !important; }
          .screener-info-grid { display: block !important; }
          .screener-info-grid > * { break-inside: avoid; margin-bottom: 0.75rem; }
        }
      `}</style>

      <p style={styles.backLink} className="screener-info-back-link">
        <a href="/screener">← Back to screener</a>
      </p>
      <h1 style={styles.heading}>Vaccine screener — full rule list</h1>
      <p style={styles.note}>
        Guidance current as of Sept 2026 (CDC/ACIP); verify before administering.
      </p>

      <div className="screener-info-grid">
        {DESCRIBED_VACCINES.map((vaccine) => (
          <article key={vaccine.id} style={styles.card}>
            <h2 style={styles.cardName}>{vaccineDisplayName(vaccine.name)}</h2>

            {SECTIONS.map(({ key, label }) => {
              const tiers = vaccine[key];
              if (tiers.length === 0) return null;
              return (
                <div key={key} style={styles.section}>
                  <p style={styles.sectionLabel}>{label}</p>
                  {tiers.map((tier, index) => (
                    <div key={index} style={styles.tierLine}>
                      <span style={styles.tierMain}>{tierAgeText(tier)}</span>
                      {tier.conditions && (
                        <ul style={styles.conditionsList}>
                          {tier.conditions.map((condition) => (
                            <li key={condition} style={styles.conditionItem}>
                              {condition}
                            </li>
                          ))}
                        </ul>
                      )}
                      <span style={styles.tierReason}>{tier.reason}</span>
                    </div>
                  ))}
                </div>
              );
            })}

            {vaccine.sources.length > 0 && (
              <div style={styles.sources}>
                {vaccine.sources.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" style={styles.sourceLink}>
                    Source: {sourceLinkLabel(url)}
                  </a>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </main>
  );
}
