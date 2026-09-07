/**
 * Settings absorbs every page not called out as its own top tab
 * (V-cloud-tabs, Will 2026-09-05, fourth message: "other not mentioned
 * pages go within the settings page") — Active vaccines and Physicians
 * are plain links out to their own full pages (both are too big a
 * table/form set to usefully inline here), plus the desktop app install
 * steps inlined directly since that's just static instructions.
 *
 * Split into their own file (rather than living in page.tsx) because
 * Next.js's App Router rejects any named export from a page.tsx besides
 * a small fixed set (metadata, generateMetadata, ...) — `next build`'s
 * page-type check fails the build otherwise. Being hook-free function
 * components also makes them directly callable and inspectable in a
 * unit test without React/DOM (see app/data-entry/instructions.tsx for
 * the same pattern) — both are rendered even in page.tsx's signed-out
 * view, since neither needs auth.
 */

const styles = {
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
    whiteSpace: "pre" as const,
    marginBottom: "0.5rem",
  },
  linkList: { paddingLeft: "1.25rem" },
} as const;

export function OtherSettingsLinks() {
  return (
    <section style={styles.section}>
      <h2>Other settings</h2>
      <ul style={styles.linkList}>
        <li>
          <a href="/vaccines">Active vaccines</a> — the formulary, cash pricing, and (once migrated) Pioneer
          quantity/directions defaults.
        </li>
        <li>
          <a href="/physicians">Physicians</a> — protocol physicians and the vaccine/age-range assignment rules.
        </li>
      </ul>
    </section>
  );
}

/** Exact PowerShell install steps (Will's brief, item E) — NEVER a
 * hardcoded username in the path: `$env:USERPROFILE` resolves per-machine
 * the same way `$HOME` does in the macOS/manager conventions this repo
 * follows elsewhere. */
export function InstallDesktopAppSection() {
  return (
    <section style={styles.section}>
      <h2>Install the desktop app</h2>
      <p style={styles.muted}>
        Run in PowerShell on the pharmacy computer. Installs prerequisites, creates a desktop shortcut, and signs in
        automatically.
      </p>
      <p>1. Clone the repo (skip if already cloned):</p>
      <pre style={styles.codeBlock}>
        git clone https://github.com/elevatedev4/vaccine-assist $env:USERPROFILE\claude\vaccine-assist
      </pre>
      <p>2. Run the updater/launcher:</p>
      <pre style={styles.codeBlock}>
        powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\claude\vaccine-assist\desktop\update-and-run.ps1
      </pre>
    </section>
  );
}
