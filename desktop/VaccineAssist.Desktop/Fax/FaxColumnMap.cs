namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// V-T53 (Will's brief): the header names ReportImporter looks for in an
/// imported *.csv/*.xlsx immunization report — configurable per
/// workstation via the Settings window's "column map editor" grid, and
/// persisted as part of <see cref="FaxSettings"/> in settings.json.
///
/// Every header is matched case-insensitively against the file's actual
/// header row (see ReportRowReader). Defaults below are Pioneer Rx's real
/// immunization report export (V-T53 401/column-map follow-up, Will
/// 2026-09-23 — verified against his own report's header row, header row
/// 1, one sheet "Sheet1", one row per immunization): "Immunization
/// Administered On" / "Patient Full Name Last then First" / "Patient Date
/// of Birth" / "Dispensed Item Name" / "Primary Care Prescriber" /
/// "Primary Care Prescriber Fax" — exactly those six columns, nothing
/// else. Still fully re-mappable in the Settings grid for a workstation
/// whose export differs.
///
/// Required (never null/blank, brief's own wording): patient name,
/// vaccine name, administered date. Every other header is optional — a
/// report missing an optional column just leaves that field blank on
/// every row, never rejects the file (see ReportImporter.ValidateHeaders).
/// </summary>
public sealed class FaxColumnMap
{
    /// <summary>Pioneer's report has ONE combined "Last, First" name
    /// column rather than separate first/last columns — when this is
    /// configured (the default), ReportRowParser splits it into
    /// PatientFirstName/PatientLastName and PatientFirstNameHeader/
    /// PatientLastNameHeader below are ignored. Blank this out (and fill
    /// in the two headers below instead) for a workstation whose export
    /// uses separate first/last name columns.</summary>
    public string? PatientFullNameHeader { get; set; } = "Patient Full Name Last then First";

    /// <summary>Used only when PatientFullNameHeader is blank — see its
    /// own doc comment.</summary>
    public string PatientFirstNameHeader { get; set; } = "";

    /// <summary>Used only when PatientFullNameHeader is blank — see its
    /// own doc comment.</summary>
    public string PatientLastNameHeader { get; set; } = "";

    public string VaccineNameHeader { get; set; } = "Dispensed Item Name";
    public string AdministeredDateHeader { get; set; } = "Immunization Administered On";

    public string? DobHeader { get; set; } = "Patient Date of Birth";
    public string? LotHeader { get; set; }
    public string? ManufacturerHeader { get; set; }
    public string? DoseHeader { get; set; }
    public string? RouteHeader { get; set; }
    public string? SiteHeader { get; set; }
    public string? PharmacistHeader { get; set; }
    public string? PrescriberNameHeader { get; set; } = "Primary Care Prescriber";
    public string? PrescriberNpiHeader { get; set; }
    public string? PrescriberFaxHeader { get; set; } = "Primary Care Prescriber Fax";
    public string? VisDateHeader { get; set; }

    /// <summary>The headers ReportImporter.ValidateHeaders rejects a file
    /// for missing — paired with the ImmunizationRecord field each backs,
    /// for a clear rejection message. Patient name is ONE required header
    /// (the combined full-name column) when PatientFullNameHeader is
    /// configured, or TWO (first + last) when it isn't — see that
    /// property's own doc comment.</summary>
    public IEnumerable<(string Field, string Header)> RequiredHeaders()
    {
        if (!string.IsNullOrWhiteSpace(PatientFullNameHeader))
        {
            yield return ("patient full name", PatientFullNameHeader);
        }
        else
        {
            yield return ("patient first name", PatientFirstNameHeader);
            yield return ("patient last name", PatientLastNameHeader);
        }

        yield return ("vaccine name", VaccineNameHeader);
        yield return ("administered date", AdministeredDateHeader);
    }
}
