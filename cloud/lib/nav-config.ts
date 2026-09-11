/**
 * Top tab nav config (V-cloud-tabs, Will 2026-09-05: "organized as a
 * single site with tabs for Schedule / Ordering / Data Entry / Lots /
 * Settings"). Pure data + pure matching logic here, deliberately
 * separated from the rendering component (components/top-nav.tsx) so the
 * active-tab logic is unit-testable without React/DOM.
 *
 * /vaccines and /physicians are intentionally NOT top-level tabs — they
 * stay reachable only from links inside the Settings page (see
 * app/settings/page.tsx).
 */

export type NavTab = { label: string; href: string };

export const NAV_TABS: readonly NavTab[] = [
  { label: "Schedule", href: "/appointments" },
  { label: "Ordering", href: "/ordering" },
  { label: "Data Entry", href: "/data-entry" },
  { label: "Lots", href: "/lots" },
  { label: "Macro codes", href: "/macro-codes" },
  { label: "Settings", href: "/settings" },
];

/**
 * True when `pathname` IS this tab's page, or a sub-path of it (e.g.
 * "/lots/123" still highlights "Lots"). Exact string match first (cheap,
 * covers the common case), then a "/"-bounded prefix check so "/lots"
 * doesn't also light up for an unrelated route like "/lotsomething".
 */
export function isTabActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type NavItem = NavTab & { active: boolean };

/** NAV_TABS annotated with whether each is active for `pathname`. */
export function buildNavItems(pathname: string): NavItem[] {
  return NAV_TABS.map((tab) => ({ ...tab, active: isTabActive(pathname, tab.href) }));
}

/**
 * Whether the shared top tab strip (V-cloud-tabs) should render at all
 * (MSG-895, Will verbatim: "signin page shouldn't have anything visible
 * but the login form ... remove all the extra stuff (tabs)"). A
 * signed-out visitor sees only that page's own sign-in form — no tab
 * bar. `authChecked` is required alongside `hasSession` so the nav never
 * flashes in during the brief window before the session check resolves,
 * then disappears once it resolves to "signed out" — it simply never
 * renders during that window either.
 */
export function shouldShowNav(authChecked: boolean, hasSession: boolean): boolean {
  return authChecked && hasSession;
}
