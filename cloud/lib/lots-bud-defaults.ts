/**
 * Pure "which products get an editable beyond-use-date cell on /lots
 * when nothing's been explicitly saved yet" logic — split out of
 * lib/lots-settings.ts (which has `import "server-only"` and so can't
 * be imported from app/lots/page.tsx, a "use client" component) so both
 * the server route (GET/PUT /api/lots/settings) and the client page can
 * compute the SAME default set instead of the page falling back to
 * "nothing enabled" whenever a settings fetch fails.
 *
 * V-T-ordering-lots-round3 (Will 2026-09-09 verbatim): "Beyond-use date
 * only needs to apply to mNexspike right now" — the original default.
 * Extended by Will 2026-09-25 4:58pm verbatim: "vaccine lots: make sure
 * Moderna Spikevax 2026-27 always has Beyond use date showed. It keeps
 * hiding itself." Root cause: the default only matched "mnexspike" in
 * the display name, so a fresh/failed settings load never enabled
 * Spikevax. Fixed by matching on BOTH product name substrings — see
 * DEFAULT_BUD_PRODUCT_NAME_SUBSTRINGS. There's exactly one catalog
 * product whose display name contains "spikevax" (lib/vaccine-product-
 * catalog.ts's "Spikevax 2026-27 (6 mo-11 yr)" entry — mNEXSPIKE is the
 * separate 12+ Moderna COVID product), so a plain substring match is
 * safe and, deliberately, doesn't hardcode the "2026-27" season suffix
 * (which lib/apply-lot-list.ts's computeEffectiveName rewrites every
 * season) — matching just "spikevax" keeps working across season
 * rollovers the same way the existing "mnexspike" match already does.
 */

import { buildProductViews, type ProductViewVaccine } from "@/lib/product-view";

/** Case-insensitive substrings of ProductView.displayName that get BUD
 * enabled by default when the `lots.bud_enabled_products` setting has
 * never been saved (or a load of it fails) — see this file's header. */
const DEFAULT_BUD_PRODUCT_NAME_SUBSTRINGS = ["mnexspike", "spikevax"] as const;

/**
 * The DEFAULT lots.bud_enabled_products value when nothing has ever been
 * saved (or a load of the saved value fails): every product whose
 * ProductView.displayName contains any of
 * DEFAULT_BUD_PRODUCT_NAME_SUBSTRINGS. NOT hardcoded productKeys —
 * computed from the LIVE vaccine catalog via lib/product-view.ts's
 * buildProductViews, so it keeps matching each product's real
 * lib/lots-grouping.ts key (a `name:` key today, an `ndc:` key the
 * moment that product gets an NDC on file) rather than a value that
 * could silently stop matching if that ever changes. Returns [] if no
 * product's display name matches at all (an empty/unusual catalog —
 * defensive, not expected in practice). Order follows buildProductViews'
 * own (catalog) order.
 */
export function defaultBudEnabledProductKeys(vaccines: readonly ProductViewVaccine[]): string[] {
  return buildProductViews(vaccines)
    .filter((view) => {
      const name = view.displayName.toLowerCase();
      return DEFAULT_BUD_PRODUCT_NAME_SUBSTRINGS.some((substring) => name.includes(substring));
    })
    .map((view) => view.productKey);
}

/**
 * Whether a /lots row's beyond-use-date cell should be shown/editable —
 * true when the product's BUD setting is enabled, OR (Will 2026-09-25
 * verbatim, item (c) of the same brief) the row already has a
 * beyond-use date on file, regardless of the setting: a lot that was
 * given a BUD while the setting was on must keep showing/editing it even
 * if the setting is later turned off, rather than hiding a real
 * persisted value.
 */
export function isBudFieldVisible(enabledByProductSetting: boolean, existingBeyondUseDate: string | null | undefined): boolean {
  return enabledByProductSetting || !!(existingBeyondUseDate && existingBeyondUseDate.trim().length > 0);
}
