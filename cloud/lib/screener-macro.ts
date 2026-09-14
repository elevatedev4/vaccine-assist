import { groupMacroRowsBySection, type MacroProductGroup, type MacroRow } from "@/lib/macro-codes";
import { shortCodeMatchesScreenerRule } from "@/lib/screener";

/**
 * Bridges the SCREENER's rule ids (lib/screener-rules.ts) to the REAL,
 * live product data the Macro codes page already builds from
 * vaccines+lots (lib/macro-codes.ts's MacroProductGroup) — so
 * app/screener/page.tsx can render one screener "product" (e.g.
 * "Shingrix") as the exact same copy-to-clipboard dose buttons
 * app/macro-codes/page.tsx uses, instead of re-deriving product/dose
 * data of its own. Kept out of lib/screener.ts (pure, DB-agnostic rule
 * evaluation — see that file's header) and out of lib/macro-codes.ts
 * (owns the Macro codes page's own grouping, unaware the screener
 * exists) so neither file's own tests/purpose changes.
 */

/**
 * Finds every real MacroProductGroup (already built the normal
 * app/macro-codes/page.tsx way — buildProductViews -> buildMacroRows ->
 * groupMacroRowsBySection) whose short code belongs to `screenerId`'s
 * product family (lib/screener.ts's SCREENER_RULE_MACRO_INFO). Usually
 * one entry; can be more than one when a rule spans multiple real
 * packagings (Flucelvax's MDV vial vs. PFS syringe — both still "give
 * routine flu vaccine"); empty when the pharmacy has no matching vaccine
 * on file yet (nothing to render as a button for that screener result).
 */
export function matchScreenerProducts(rows: readonly MacroRow[], screenerId: string): MacroProductGroup[] {
  const allProducts = groupMacroRowsBySection(rows).flatMap((section) => section.products);
  return allProducts.filter((product) =>
    product.doses.some((dose) => dose.row.shortCode && shortCodeMatchesScreenerRule(dose.row.shortCode, screenerId))
  );
}
