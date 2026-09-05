using System;
using System.Collections.Generic;
using System.Linq;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Maps a catalog Vaccine to the common-name GROUP the data-entry popup's
/// guided flow shows as its second question (age -> GROUP -> product ->
/// dose — see DataEntryPopupViewModel and its brief's example list: COVID,
/// Flu, Pneumonia, Tetanus/whooping cough, Shingles, RSV, HPV, Hep A,
/// Hep B, MMR, Meningitis, Typhoid).
///
/// JUDGMENT CALL (flagged for Will): the `vaccine` table
/// (supabase/migrations/0001_init.sql) has no `category`/`common_group`
/// column — name, ndc, dose, short_code, cash_price_cents, active is the
/// whole row. Adding one would mean a migration PLUS updating the
/// formulary reseed pipeline (cloud/scripts/parse-formulary.mjs, which
/// regenerates supabase/seed/vaccines.sql in full from the pharmacy's
/// v-macro-codes.xlsx on every run) for something that is, today, purely a
/// DISPLAY grouping for this one popup screen. A static name-prefix lookup
/// here is the smaller, reversible option — no schema/reseed change, easy
/// to re-map if a name changes. If the formulary grows enough that this
/// table drifts out of sync often, promoting it to a real
/// `vaccine.common_group` column (set once at seed time, no runtime
/// guessing) is the natural next step.
///
/// Matching is by CONTAINS, case-insensitive, against the current
/// supabase/seed/vaccines.sql formulary (2026-09-04) — not exact-name
/// equality — since several real rows carry a trailing season/age
/// qualifier that a future reseed could change without notice (e.g.
/// "Comirnaty 2025-26 12+", "Engerix 20 (age 20+)", "FluMist (age 2-49)").
/// Anything that doesn't match a known prefix falls into <see cref="OtherGroup"/>
/// rather than being silently dropped from every group's eligible list.
/// </summary>
public static class VaccineGroupCatalog
{
    public const string OtherGroup = "Other";

    private static readonly (string Group, string[] NamePrefixes)[] Mappings =
    {
        ("COVID", new[] { "Comirnaty", "Spikevax", "mNEXSPIKE", "Novavax" }),
        ("Flu", new[] { "Afluria", "Fluad", "Flucelvax", "FluMist", "Fluzone", "Flublok" }),
        ("Pneumonia", new[] { "Prevnar", "Capvaxive", "Pneumovax", "Vaxneuvance" }),
        ("Tetanus/whooping cough", new[] { "Boostrix", "Adacel", "Tdap" }),
        ("Shingles", new[] { "Shingrix" }),
        ("RSV", new[] { "Abrysvo", "Arexvy", "mResvia" }),
        ("HPV", new[] { "Gardasil" }),
        ("Hep A", new[] { "Vaqta", "Havrix", "Twinrix" }),
        ("Hep B", new[] { "Engerix", "Recombivax", "Heplisav" }),
        ("MMR", new[] { "MMR-II", "Priorix", "M-M-R" }),
        ("Meningitis", new[] { "Menveo", "Bexsero", "Trumenba", "MenQuadfi" }),
        ("Typhoid", new[] { "Typhim", "Vivotif" }),
    };

    /// <summary>Display order the guided flow's group step lists options
    /// in — matches Will's brief order, with <see cref="OtherGroup"/> last
    /// as a catch-all for anything not (yet) mapped above.</summary>
    public static readonly IReadOnlyList<string> DisplayOrder = Mappings
        .Select(m => m.Group)
        .Append(OtherGroup)
        .ToArray();

    public static string GetGroup(Vaccine vaccine)
    {
        var name = vaccine.Name ?? "";
        foreach (var (group, prefixes) in Mappings)
        {
            if (prefixes.Any(prefix => name.Contains(prefix, StringComparison.OrdinalIgnoreCase)))
            {
                return group;
            }
        }
        return OtherGroup;
    }
}
