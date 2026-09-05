using System.Collections.Generic;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// One row in the data-entry popup's guided-flow PRODUCT step (age -> group
/// -> PRODUCT -> dose). Groups every catalog Vaccine row that shares the
/// same Name — e.g. Gardasil's three dose rows (dose "1"/"2"/"3", each its
/// own short_code: gardasil1/gardasil2/gardasil3 — see
/// supabase/seed/vaccines.sql) — into one radio-button choice.
///
/// JUDGMENT CALL (flagged for Will): the brief asked to add a nullable
/// dose_count field (new column, or a hardcoded map) if the catalog had no
/// dose-count data. It already does, just not as a count — a multi-dose
/// series is represented as multiple SEPARATE vaccine rows sharing one
/// Name, each with its own `dose` string ("1", "2", "3") and its own
/// short_code/eligibility rule (see MMR-II, Priorix, Shingrix, Engerix,
/// Vaqta adult, Gardasil in supabase/seed/vaccines.sql — all multi-row).
/// So "how many doses does this product have" is just "how many rows share
/// this Name", and DoseRows below IS that — no new column, migration, or
/// hardcoded map needed. See DataEntryPopupViewModel.SelectGroup, which
/// builds these by grouping the age-filtered eligible-vaccine list by Name.
/// </summary>
public sealed class VaccineProductOption
{
    public VaccineProductOption(string name, IReadOnlyList<Vaccine> doseRows)
    {
        Name = name;
        DoseRows = doseRows;
    }

    public string Name { get; }

    /// <summary>Ordered by parsed dose number (see DataEntryPopupViewModel.OrderByDose) so a
    /// multi-dose product's dose step lists 1, 2, 3 in the right order.</summary>
    public IReadOnlyList<Vaccine> DoseRows { get; }

    /// <summary>True when this product needs the guided flow's extra DOSE
    /// step; false means DoseRows has exactly one row and SelectProduct
    /// can go straight to it.</summary>
    public bool IsMultiDose => DoseRows.Count > 1;

    public override string ToString() => Name;
}
