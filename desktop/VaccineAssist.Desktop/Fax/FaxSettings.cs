namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// V-T53 (Will's brief, HQ): "the desktop app will read an immunization
/// report file from a LOCAL FOLDER ... build ONE PDF PER PATIENT ...
/// fax each via SRFax's API to the patient's PCP ... track delivery
/// receipts, run automatically daily." Everything here is non-secret and
/// lives inside AppSettings/settings.json — SRFax's access id/password
/// are the one exception (see Fax/FaxCredentialStore.cs, DPAPI-protected,
/// a separate file, never here).
/// </summary>
public sealed class FaxSettings
{
    /// <summary>Notifyre is the default for a fresh install (Will's pick,
    /// V-T53 follow-up) — SRFax stays available for any install that was
    /// already configured with it. See FaxProvider's own doc comment.</summary>
    public FaxProvider Provider { get; set; } = FaxProvider.Notifyre;

    /// <summary>Folder ReportImporter scans for new *.csv/*.xlsx files. Blank
    /// on a fresh checkout — FaxRunOrchestrator treats a blank/missing
    /// folder as "nothing to import" rather than throwing.</summary>
    public string InputFolder { get; set; } = "";

    /// <summary>Column header names in the immunization report — see
    /// FaxColumnMap's own doc comment for defaults/required fields.</summary>
    public FaxColumnMap ColumnMap { get; set; } = new();

    /// <summary>Pharmacy name printed on the PDF header, e.g. "Orchards Drug".</summary>
    public string PharmacyName { get; set; } = "";

    /// <summary>Pharmacy phone printed on the PDF header/footer.</summary>
    public string PharmacyPhone { get; set; } = "";

    /// <summary>Pharmacy fax number — sent to SRFax as sCallerID (the
    /// "from" number shown on the received fax) AND printed on the PDF
    /// header.</summary>
    public string PharmacyFax { get; set; } = "";

    /// <summary>SRFax sSenderEmail — where SRFax sends delivery
    /// notifications; not printed on the PDF.</summary>
    public string SenderEmail { get; set; } = "";

    /// <summary>Optional SRFax sub-account code (sAccountCode). Blank is
    /// valid — most SRFax accounts don't use sub-accounts.</summary>
    public string? AccountCode { get; set; }

    /// <summary>Local time-of-day (HH:mm, 24h) the daily run fires — see
    /// Fax/FaxScheduleDecision.cs. Default matches the brief's "default
    /// 18:30".</summary>
    public string DailyRunTime { get; set; } = "18:30";

    /// <summary>Tray menu's "Vaccine faxes" daily timer on/off switch —
    /// "Run now" always works regardless of this.</summary>
    public bool DailyRunEnabled { get; set; } = true;
}
