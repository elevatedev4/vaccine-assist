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

    /// <summary>SRFax-specific completeness check — NotifyreFaxClient
    /// checks ApiToken directly instead, since a SRFax-only or
    /// Notifyre-only install will legitimately have the other vendor's
    /// fields blank.</summary>
    public bool IsComplete => !string.IsNullOrWhiteSpace(AccessId) && !string.IsNullOrWhiteSpace(AccessPassword);
}
