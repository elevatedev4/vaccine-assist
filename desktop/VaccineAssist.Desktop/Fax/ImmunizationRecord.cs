namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// One row of an imported immunization report — see ReportImporter/
/// ReportRowReader. Only PatientFirstName/PatientLastName/VaccineName/
/// AdministeredDate are guaranteed non-blank (FaxColumnMap's required
/// headers); every other field is whatever the report had, or blank/null
/// when that column wasn't configured or was empty on this row.
/// </summary>
public sealed class ImmunizationRecord
{
    public required string PatientFirstName { get; init; }
    public required string PatientLastName { get; init; }
    public DateOnly? PatientDob { get; init; }

    public required string VaccineName { get; init; }
    public string? Lot { get; init; }
    public string? Manufacturer { get; init; }
    public string? Dose { get; init; }
    public string? Route { get; init; }
    public string? Site { get; init; }
    public required DateOnly AdministeredDate { get; init; }
    public DateOnly? VisDate { get; init; }
    public string? Pharmacist { get; init; }

    public string? PrescriberName { get; init; }
    public string? PrescriberNpi { get; init; }

    /// <summary>Fax number straight from the report column, when
    /// configured/present — takes priority over PrescriberDirectory (see
    /// FaxRunOrchestrator.ResolvePrescriberFax).</summary>
    public string? PrescriberFax { get; init; }

    /// <summary>Which imported file this row came from — operational only
    /// (surfaced in a rejection/duplicate message), never PHI on its own.</summary>
    public string? SourceFile { get; init; }

    public string PatientFullName => $"{PatientFirstName} {PatientLastName}".Trim();

    /// <summary>"<first-initial><last-initial>" — the only patient
    /// identifier ever written to the log or the fax ledger (Will's
    /// brief: "log patient initials + fax last-4 only, never full
    /// name/DOB in logs").</summary>
    public string PatientInitials =>
        $"{(PatientFirstName.Length > 0 ? PatientFirstName[0] : '?')}{(PatientLastName.Length > 0 ? PatientLastName[0] : '?')}"
            .ToUpperInvariant();

    /// <summary>Normalized prescriber lookup key — NPI when present
    /// (digits only), otherwise the normalized prescriber name. Never
    /// null/blank: an entirely blank prescriber groups together under a
    /// single "(unknown prescriber)" key rather than silently splitting
    /// one patient's shots across several bogus groups.</summary>
    public string PrescriberKey =>
        !string.IsNullOrWhiteSpace(PrescriberNpi)
            ? "npi:" + new string(PrescriberNpi.Where(char.IsDigit).ToArray())
            : !string.IsNullOrWhiteSpace(PrescriberName)
                ? "name:" + PrescriberName.Trim().ToUpperInvariant()
                : "name:(unknown prescriber)";

    /// <summary>Normalized patient grouping key — first+last+DOB
    /// (uppercased/trimmed); DOB is included when present so two
    /// different patients who happen to share a name don't merge into
    /// one PDF.</summary>
    public string PatientKey =>
        $"{PatientFirstName.Trim().ToUpperInvariant()}|{PatientLastName.Trim().ToUpperInvariant()}|{PatientDob:yyyy-MM-dd}";

    /// <summary>Stable hash of (patient + vaccine + date + lot) — the
    /// dedupe key ReportImporter's imported.json ledger uses to make sure
    /// the same administration is never faxed twice across runs (Will's
    /// brief). Deliberately excludes prescriber/manufacturer/etc. — those
    /// can be corrected in a re-export without the row being treated as a
    /// new administration.</summary>
    public string Fingerprint => RowFingerprint.Compute(this);
}
