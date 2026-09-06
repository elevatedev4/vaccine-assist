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
