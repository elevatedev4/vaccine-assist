/**
 * The static instructional content for /data-entry (V-cloud-tabs, Will
 * 2026-09-05, second message: "no web data-entry capability — just
 * instructions"). Split into its own file (rather than living in
 * page.tsx) because Next.js's App Router rejects any named export from a
 * page.tsx besides a small fixed set (metadata, generateMetadata, ...) —
 * `next build`'s page-type check fails the build otherwise. Being its
 * own hook-free function component also makes it directly callable and
 * inspectable in a unit test without React/DOM (this project has no
 * jsdom/testing-library — see vitest.config.ts's "node" environment).
 */

const styles = {
  muted: { color: "#555", fontSize: "0.875rem" },
  stepsBox: {
    padding: "1rem 1.25rem",
    marginTop: "1rem",
    background: "#fafafa",
    border: "1px solid #ddd",
    borderRadius: 4,
  },
  kbd: {
    fontFamily: "ui-monospace, monospace",
    background: "#eef",
    padding: "0.1rem 0.4rem",
    borderRadius: 3,
    fontWeight: 600,
  },
} as const;

export function DataEntryInstructions() {
  return (
    <>
      <h1>Data entry</h1>
      <p>
        Data entry into PioneerRx happens from the <strong>desktop app</strong>, not here — this page has no
        data-entry form of its own.
      </p>
      <div style={styles.stepsBox}>
        <ol>
          <li>Open the patient&apos;s Rx Profile in PioneerRx.</li>
          <li>
            Launch the Vaccine Assist desktop app (see Settings for install instructions if it&apos;s not installed
            yet).
          </li>
          <li>
            Press <kbd style={styles.kbd}>Ctrl</kbd> + <kbd style={styles.kbd}>Keypad 2</kbd> from the Rx Profile
            screen — this opens the guided vaccine entry popup.
          </li>
        </ol>
      </div>
      <p style={styles.muted}>
        Need the desktop app installed on this computer? See <a href="/settings">Settings</a> for the install steps.
      </p>
    </>
  );
}
