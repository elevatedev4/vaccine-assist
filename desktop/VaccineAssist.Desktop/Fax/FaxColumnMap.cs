namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// V-T53 (Will's brief): the header names ReportImporter looks for in an
/// imported *.csv/*.xlsx immunization report — configurable per
/// workstation (Pioneer Rx's own export column names aren't fixed across
/// installs) via the Settings window's "column map editor" grid, and
/// persisted as part of <see cref="FaxSettings"/> in settings.json.
///
/// Every header is matched case-insensitively against the file's actual
/// header row (see ReportRowReader). Defaults below are Pioneer-looking
/// guesses, not verified against a real export — that's exactly why this
/// is configurable rather than hardcoded.
///
/// Required (never null/blank, brief's own wording): patient first/last
/// name, vaccine name, administered date. Every other header is optional —
/// a report missing an optional column just leaves that field blank on
/// every row, never rejects the file (see ReportImporter.ValidateHeaders).
/// </summary>
public sealed class FaxColumnMap
{
    public string PatientFirstNameHeader { get; set; } = "Patient First Name";
    public string PatientLastNameHeader { get; set; } = "Patient Last Name";
    public string VaccineNameHeader { get; set; } = "Vaccine";
    public string AdministeredDateHeader { get; set; } = "Date Administered";

    public string? DobHeader { get; set; } = "DOB";
    public string? LotHeader { get; set; } = "Lot Number";
    public string? ManufacturerHeader { get; set; } = "Manufacturer";
    public string? DoseHeader { get; set; } = "Dose";
    public string? RouteHeader { get; set; } = "Route";
    public string? SiteHeader { get; set; } = "Site";
    public string? PharmacistHeader { get; set; } = "Pharmacist";
    public string? PrescriberNameHeader { get; set; } = "Prescriber Name";
    public string? PrescriberNpiHeader { get; set; } = "Prescriber NPI";
    public string? PrescriberFaxHeader { get; set; } = "Prescriber Fax";
    public string? VisDateHeader { get; set; } = "VIS Date";

    /// <summary>The four headers ReportImporter.ValidateHeaders rejects a
    /// file for missing — paired with the ImmunizationRecord field each
    /// backs, for a clear rejection message.</summary>
    public IEnumerable<(string Field, string Header)> RequiredHeaders()
    {
        yield return ("patient first name", PatientFirstNameHeader);
        yield return ("patient last name", PatientLastNameHeader);
        yield return ("vaccine name", VaccineNameHeader);
        yield return ("administered date", AdministeredDateHeader);
    }
}
