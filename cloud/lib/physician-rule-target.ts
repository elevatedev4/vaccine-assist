/**
 * V-cloud-tabs (Will, 2026-09-05/07, rule #5): the /physicians rule
 * dropdown's single <select> encodes its value as either `id:<uuid>`
 * (a specific vaccine) or `group:<GroupName>` (a whole catalog group —
 * see lib/vaccine-group-catalog.ts). This is the pure parsing half of
 * that encoding, split out of app/physicians/page.tsx into lib/ so it's
 * unit-testable without the page's hooks/session state, and so
 * page.tsx (a Next.js page.tsx file) doesn't carry an extra named export
 * — Next's App Router rejects any page.tsx export besides a small fixed
 * set (metadata, generateMetadata, ...) and fails `next build` otherwise.
 */
export function parseRuleTargetValue(value: string): { vaccineId: string | null; vaccineGroup: string | null } {
  if (value.startsWith("id:")) return { vaccineId: value.slice(3), vaccineGroup: null };
  if (value.startsWith("group:")) return { vaccineId: null, vaccineGroup: value.slice(6) };
  return { vaccineId: null, vaccineGroup: null };
}
