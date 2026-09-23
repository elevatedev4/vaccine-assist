namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Which fax vendor's <see cref="IFaxClient"/> implementation the app
/// talks to. Will picked Notifyre (see Fax/NotifyreFaxClient.cs) — SRFax
/// stays supported too rather than being ripped out, since keeping this a
/// settings enum (rather than hardcoding one vendor everywhere) means
/// adding/keeping a second vendor is a one-file add (a new IFaxClient
/// implementation plus a case here), not a rewrite of
/// FaxRunOrchestrator/FaxSettingsWindow/etc., which all depend on
/// IFaxClient's vendor-neutral shape, never SrFaxClient/NotifyreFaxClient
/// directly.
/// </summary>
public enum FaxProvider
{
    SrFax,
    Notifyre,
}
