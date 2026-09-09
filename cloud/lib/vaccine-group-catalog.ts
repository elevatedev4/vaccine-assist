/**
 * Client-safe port of the desktop app's VaccineGroupCatalog
 * (desktop/VaccineAssist.Desktop/Models/VaccineGroupCatalog.cs) — maps a
 * catalog vaccine's name to the common-name GROUP the /data-entry guided
 * flow's second question shows (age -> GROUP -> product -> dose).
 *
 * KEEP IN SYNC with the desktop source above — this is a small, static
 * name-prefix lookup duplicated here (not shared code) because the
 * desktop app is C#/WPF and this is the cloud Next.js app; there is no
 * existing shared TypeScript/C# package boundary in this repo to hang a
 * single source of truth off of. Same JUDGMENT CALL the desktop file
 * documents: the `vaccine` table has no `category`/`common_group`
 * column, so this is a display-only grouping, matched by CONTAINS
 * (case-insensitive) against the vaccine name, never exact equality.
 */

export const OTHER_GROUP = "Other";

const MAPPINGS: ReadonlyArray<{ group: string; namePrefixes: readonly string[] }> = [
  { group: "COVID", namePrefixes: ["Comirnaty", "Spikevax", "mNEXSPIKE", "Novavax"] },
  { group: "Flu", namePrefixes: ["Afluria", "Fluad", "Flucelvax", "FluMist", "Fluzone", "Flublok"] },
  { group: "Pneumonia", namePrefixes: ["Prevnar", "Capvaxive", "Pneumovax", "Vaxneuvance"] },
  { group: "Tetanus/whooping cough", namePrefixes: ["Boostrix", "Adacel", "Tdap"] },
  { group: "Shingles", namePrefixes: ["Shingrix"] },
  { group: "RSV", namePrefixes: ["Abrysvo", "Arexvy", "mResvia"] },
  { group: "HPV", namePrefixes: ["Gardasil"] },
  { group: "Hep A", namePrefixes: ["Vaqta", "Havrix", "Twinrix"] },
  { group: "Hep B", namePrefixes: ["Engerix", "Recombivax", "Heplisav"] },
  { group: "MMR", namePrefixes: ["MMR-II", "Priorix", "M-M-R"] },
  { group: "Meningitis", namePrefixes: ["Menveo", "Bexsero", "Trumenba", "MenQuadfi"] },
  { group: "Typhoid", namePrefixes: ["Typhim", "Vivotif"] },
];

/** Display order the guided flow's group step lists options in — matches
 * the desktop's DisplayOrder, with OTHER_GROUP last as a catch-all. */
export const GROUP_DISPLAY_ORDER: readonly string[] = [...MAPPINGS.map((m) => m.group), OTHER_GROUP];

/** Case-insensitive substring match, same as the desktop's
 * `name.Contains(prefix, StringComparison.OrdinalIgnoreCase)`. */
export function getVaccineGroup(name: string | null | undefined): string {
  const haystack = (name ?? "").toLowerCase();
  for (const { group, namePrefixes } of MAPPINGS) {
    if (namePrefixes.some((prefix) => haystack.includes(prefix.toLowerCase()))) {
      return group;
    }
  }
  return OTHER_GROUP;
}

/** Every group present among `names`, in GROUP_DISPLAY_ORDER's order —
 * mirrors DataEntryPopupViewModel.BuildAvailableGroups. */
export function availableGroupsFor(names: ReadonlyArray<string | null | undefined>): string[] {
  const present = new Set(names.map(getVaccineGroup));
  return GROUP_DISPLAY_ORDER.filter((group) => present.has(group));
}

/**
 * ADDITIVE — Physicians-tab-only grouping (V-T21 item 7, Will 2026-09-08,
 * verbatim): "On physicians tab, group 'Flu vaccines' and 'COVID
 * vaccines' and everything else goes into 'Other vaccines'." A coarser
 * 3-bucket scheme layered on top of the fine-grained groups above (which
 * the /data-entry guided flow still uses UNCHANGED — see getVaccineGroup/
 * GROUP_DISPLAY_ORDER/availableGroupsFor above, none of which are
 * modified here) — reuses getVaccineGroup's own Flu/COVID detection
 * rather than a second name-prefix list, mirrored 1:1 with the desktop
 * app's additive VaccineGroupCatalog.GetPhysiciansGroup (Models/
 * VaccineGroupCatalog.cs).
 */
export const PHYSICIANS_FLU_GROUP = "Flu vaccines";
export const PHYSICIANS_COVID_GROUP = "COVID vaccines";
export const PHYSICIANS_OTHER_GROUP = "Other vaccines";

export const PHYSICIANS_GROUP_DISPLAY_ORDER: readonly string[] = [
  PHYSICIANS_FLU_GROUP,
  PHYSICIANS_COVID_GROUP,
  PHYSICIANS_OTHER_GROUP,
];

export function getPhysiciansGroup(name: string | null | undefined): string {
  const fineGroup = getVaccineGroup(name);
  if (fineGroup === "Flu") return PHYSICIANS_FLU_GROUP;
  if (fineGroup === "COVID") return PHYSICIANS_COVID_GROUP;
  return PHYSICIANS_OTHER_GROUP;
}

/** Every physicians-tab group present among `names`, in
 * PHYSICIANS_GROUP_DISPLAY_ORDER's order — mirrors availableGroupsFor
 * above, just over the coarser 3-bucket scheme. */
export function availablePhysiciansGroupsFor(names: ReadonlyArray<string | null | undefined>): string[] {
  const present = new Set(names.map(getPhysiciansGroup));
  return PHYSICIANS_GROUP_DISPLAY_ORDER.filter((group) => present.has(group));
}

/** Maps a physicians-tab display group back to the persisted
 * PhysicianRule.vaccine_group value ("Flu"/"COVID", the same fine-grained
 * group name the schema/physician-resolution logic already expects — see
 * supabase/migrations/0009_lots_bud_vaccine_defaults.sql) — or null for
 * the catch-all "Other vaccines" group, which has no wildcard rule
 * option (Will's brief: "the 'All <group> vaccines' rule options only for
 * Flu and COVID"). */
export function persistedGroupForPhysiciansGroup(group: string): string | null {
  if (group === PHYSICIANS_FLU_GROUP) return "Flu";
  if (group === PHYSICIANS_COVID_GROUP) return "COVID";
  return null;
}
