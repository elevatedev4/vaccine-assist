namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// V-T65 (Will's brief, HQ, 2026-09-29; R4 the same day made Send an
/// explicit step): one window — file picker (CSV/XLSX) + Send + results
/// grid (Views/FaxSendWindow.xaml). No input folder, no
/// scheduled/automatic run, no prescriber-fax directory — the report's own
/// Primary Care Prescriber Fax column is the only fax-number source.
/// Everything here is non-secret and lives inside AppSettings/settings.json
/// — the SRFax/Notifyre credentials are the one exception (see
/// Fax/FaxCredentialStore.cs, DPAPI-protected, a separate file, never
/// here).
/// </summary>
public sealed class FaxSettings
{
    /// <summary>Notifyre is the default for a fresh install (Will's pick,
    /// V-T53 follow-up) — SRFax stays available for any install that was
    /// already configured with it. See FaxProvider's own doc comment.</summary>
    public FaxProvider Provider { get; set; } = FaxProvider.Notifyre;

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

    /// <summary>Street address line printed in the letter's pharmacy
    /// block (fax-report-layout brief, 2026-09-28 — Will's current fax
    /// example shows a street address above city/state/zip). Blank is
    /// valid; the PDF just omits the line.</summary>
    public string PharmacyAddressLine1 { get; set; } = "";

    /// <summary>"City, ST 12345"-style line printed under
    /// PharmacyAddressLine1 in the letter's pharmacy block. Blank is
    /// valid; the PDF just omits the line.</summary>
    public string PharmacyCityStateZip { get; set; } = "";

    /// <summary>SRFax sSenderEmail — where SRFax sends delivery
    /// notifications; not printed on the PDF.</summary>
    public string SenderEmail { get; set; } = "";

    /// <summary>Optional SRFax sub-account code (sAccountCode). Blank is
    /// valid — most SRFax accounts don't use sub-accounts.</summary>
    public string? AccountCode { get; set; }

    /// <summary>Printed under "Sincerely," on the letter (fax-report-
    /// layout brief, 2026-09-28) — defaults to Will's own current
    /// signature (his brief's own default text), editable per
    /// workstation/pharmacist in Fax settings.</summary>
    public string SignatureName { get; set; } = "Will Anderson, Pharm.D.";

    /// <summary>Full path to the company logo image (%AppData%\
    /// VaccineAssist\fax\logo.&lt;ext&gt; — see FaxSettingsViewModel.SetLogo),
    /// or null for no logo. Will, verbatim, 2026-09-29: "Add a place in
    /// settings for me to upload company logo to use in the report."
    /// Printed top-left of the fax PDF header (VaccineRecordPdfBuilder) —
    /// no logo means the layout is exactly what it was before this
    /// setting existed.</summary>
    public string? LogoPath { get; set; }
}
