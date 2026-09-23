using System.Globalization;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Turns one ReportRow into an ImmunizationRecord using a FaxColumnMap —
/// format-agnostic (CSV and XLSX both funnel through ReportRow first, see
/// ReportRowReader), and pure/static so it's directly unit-testable.
/// </summary>
public static class ReportRowParser
{
    /// <summary>
    /// Null when the row is unusable even though the file's HEADERS passed
    /// ReportImporter.ValidateHeaders — i.e. this specific row is missing
    /// one of the four required VALUES (patient first/last name, vaccine,
    /// administered date) or has an unparsable administered date. Rows
    /// like this are skipped with a per-row reason rather than rejecting
    /// the whole file (only a genuinely MISSING column rejects the file —
    /// see ReportImporter).
    /// </summary>
    public static (ImmunizationRecord? Record, string? SkipReason) Parse(ReportRow row, FaxColumnMap map, string? sourceFile)
    {
        var firstName = row.Get(map.PatientFirstNameHeader);
        var lastName = row.Get(map.PatientLastNameHeader);
        var vaccine = row.Get(map.VaccineNameHeader);
        var administeredDateRaw = row.Get(map.AdministeredDateHeader);

        if (string.IsNullOrWhiteSpace(firstName) || string.IsNullOrWhiteSpace(lastName))
        {
            return (null, "missing patient name");
        }
        if (string.IsNullOrWhiteSpace(vaccine))
        {
            return (null, "missing vaccine name");
        }
        if (string.IsNullOrWhiteSpace(administeredDateRaw) || !TryParseDate(administeredDateRaw, out var administeredDate))
        {
            return (null, "missing or unparsable administered date");
        }

        TryParseDate(row.Get(map.DobHeader), out var dob);
        TryParseDate(row.Get(map.VisDateHeader), out var visDate);

        var record = new ImmunizationRecord
        {
            PatientFirstName = firstName,
            PatientLastName = lastName,
            PatientDob = dob,
            VaccineName = vaccine,
            Lot = row.Get(map.LotHeader),
            Manufacturer = row.Get(map.ManufacturerHeader),
            Dose = row.Get(map.DoseHeader),
            Route = row.Get(map.RouteHeader),
            Site = row.Get(map.SiteHeader),
            AdministeredDate = administeredDate,
            VisDate = visDate,
            Pharmacist = row.Get(map.PharmacistHeader),
            PrescriberName = row.Get(map.PrescriberNameHeader),
            PrescriberNpi = row.Get(map.PrescriberNpiHeader),
            PrescriberFax = row.Get(map.PrescriberFaxHeader),
            SourceFile = sourceFile,
        };
        return (record, null);
    }

    private static bool TryParseDate(string? raw, out DateOnly value)
    {
        value = default;
        if (string.IsNullOrWhiteSpace(raw)) return false;

        if (DateOnly.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None, out value)) return true;
        if (DateOnly.TryParse(raw, CultureInfo.CurrentCulture, DateTimeStyles.None, out value)) return true;

        // Excel sometimes hands back a serial date as plain text when a
        // column isn't formatted as a date (ClosedXML normally avoids
        // this via Cell.GetDateTime(), but ReportRowReader stringifies
        // everything through ReportRow for format-agnostic parsing — see
        // that class). 1899-12-30 is Excel's (bug-compatible) day-zero.
        if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var serial) && serial > 0)
        {
            value = DateOnly.FromDateTime(new DateTime(1899, 12, 30).AddDays(serial));
            return true;
        }

        return false;
    }
}
