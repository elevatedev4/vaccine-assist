/**
 * Settings absorbs every page not called out as its own top tab
 * (V-cloud-tabs, Will 2026-09-05, fourth message: "other not mentioned
 * pages go within the settings page") — Active vaccines and Physicians
 * are plain links out to their own full pages (both are too big a
 * table/form set to usefully inline here). The desktop install steps
 * used to be inlined directly here too, but now have their own top-
 * level tab (app/install/page.tsx, Will's later brief: "install
 * instructions ... into an install tab on the cloud") with the real
 * copy/paste one-liner instead of this page's old multi-step version —
 * this page just links out to it now.
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
  section: { marginBottom: "2rem" },
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
        <li>
          <a href="/settings/sessions">Sessions</a> — devices signed into the shared login, with revoke and sign-out-everywhere.
        </li>
      </ul>
    </section>
  );
}

/** One-line pointer to the real install instructions/one-liner, now on
 * their own tab (app/install/page.tsx) instead of inlined here. */
export function InstallDesktopAppSection() {
  return (
    <section style={styles.section}>
      <p>
        <a href="/install">Install the desktop app →</a>
      </p>
    </section>
  );
}
