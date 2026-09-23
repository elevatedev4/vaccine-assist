namespace VaccineAssist.Desktop.Fax;

/// <summary>One patient/prescriber pair's worth of administered vaccines —
/// exactly one PDF (and, if it resolves to a fax number, one fax) is built
/// per group. See FaxGrouping.GroupByPatientAndPrescriber.</summary>
public sealed class PatientFaxGroup
{
    public required string PatientKey { get; init; }
    public required string PrescriberKey { get; init; }
    public required IReadOnlyList<ImmunizationRecord> Records { get; init; }

    /// <summary>The first record in the group stands in for the shared
    /// patient/prescriber fields — every record in a group has identical
    /// PatientKey/PrescriberKey by construction, so these are safe reads.</summary>
    private ImmunizationRecord First => Records[0];

    public string PatientFirstName => First.PatientFirstName;
    public string PatientLastName => First.PatientLastName;
    public string PatientFullName => First.PatientFullName;
    public string PatientInitials => First.PatientInitials;
    public DateOnly? PatientDob => First.PatientDob;

    public string? PrescriberName => First.PrescriberName;
    public string? PrescriberNpi => First.PrescriberNpi;
    public string? PrescriberFaxFromReport => First.PrescriberFax;
}

/// <summary>
/// Will's brief: "Rows group by (patient, prescriber) -> one PDF per
/// patient per prescriber per run." Pure/static so it's unit-testable with
/// plain ImmunizationRecord lists — no file/PDF/fax dependencies.
/// </summary>
public static class FaxGrouping
{
    public static IReadOnlyList<PatientFaxGroup> GroupByPatientAndPrescriber(IEnumerable<ImmunizationRecord> records)
    {
        return records
            .GroupBy(r => (r.PatientKey, r.PrescriberKey))
            .Select(g => new PatientFaxGroup
            {
                PatientKey = g.Key.PatientKey,
                PrescriberKey = g.Key.PrescriberKey,
                // Administered date order — the PDF table should read
                // chronologically, not in whatever order the report
                // happened to list rows.
                Records = g.OrderBy(r => r.AdministeredDate).ToList(),
            })
            .ToList();
    }
}
