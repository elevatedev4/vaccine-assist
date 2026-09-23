namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Which fax vendor's <see cref="IFaxClient"/> implementation the app
/// talks to. SRFax is the only implementation as of V-T53 — Will is still
/// weighing Notifyre/Telnyx on price — but keeping this as a settings enum
/// (rather than hardcoding SRFax everywhere) means adding a second vendor
/// later is a one-file add (a new IFaxClient implementation plus a case
/// here), not a rewrite of FaxRunOrchestrator/FaxSettingsWindow/etc., which
/// all depend on IFaxClient's vendor-neutral shape, never SrFaxClient
/// directly.
/// </summary>
public enum FaxProvider
{
    SrFax,
}
