namespace VaccineAssist.Desktop.Fax;

/// <summary>In-memory (decrypted) fax vendor credentials for both
/// supported providers — SRFax's access id/password AND Notifyre's API
/// token live in the same record (only the fields the selected
/// FaxProvider actually uses are ever populated/read) so there's one
/// store/one settings-window save path for either vendor. See
/// FaxCredentialStore for the on-disk, DPAPI-protected form.</summary>
public sealed class FaxCredentials
{
    public string AccessId { get; set; } = "";
    public string AccessPassword { get; set; } = "";

    /// <summary>Notifyre's x-api-token value — see NotifyreFaxClient.</summary>
    public string ApiToken { get; set; } = "";

    /// <summary>Which header form Notifyre actually accepted this token
    /// in, last time it was checked — see NotifyreAuthMode's own doc
    /// comment. Default (a fresh/never-probed install) is the documented
    /// x-api-token form; NotifyreFaxClient.TestConnectionAsync's probe
    /// sequence updates this on this SAME object when a non-documented
    /// form is the one that actually works (V-T53 401 follow-up,
    /// 2026-09-25), and NotifyreFaxClient's send/status calls read it
    /// back to use that form every time, not just during Test
    /// connection.</summary>
    public NotifyreAuthMode NotifyreAuthMode { get; set; } = NotifyreAuthMode.XApiToken;

    /// <summary>UTC instant ApiToken was last (re)persisted — Notifyre-
    /// key-visibility follow-up (Will, 2026-09-28: "make sure the
    /// settings is storing the Notifyre key... it doesn't show that in
    /// the settings that it is"). Plain (not DPAPI-protected — it's a
    /// timestamp, not a secret) so FaxSettingsViewModel can show "saved
    /// &lt;date&gt;" without ever displaying the token itself. Null on an
    /// install that predates this field, or once ForgetKey clears it.</summary>
    public DateTime? NotifyreTokenSavedAtUtc { get; set; }

    /// <summary>SRFax-specific completeness check — NotifyreFaxClient
    /// checks ApiToken directly instead, since a SRFax-only or
    /// Notifyre-only install will legitimately have the other vendor's
    /// fields blank.</summary>
    public bool IsComplete => !string.IsNullOrWhiteSpace(AccessId) && !string.IsNullOrWhiteSpace(AccessPassword);
}
