namespace VaccineAssist.Desktop.Fax;

/// <summary>In-memory (decrypted) SRFax access id/password — see
/// FaxCredentialStore for the on-disk, DPAPI-protected form.</summary>
public sealed class FaxCredentials
{
    public string AccessId { get; set; } = "";
    public string AccessPassword { get; set; } = "";

    public bool IsComplete => !string.IsNullOrWhiteSpace(AccessId) && !string.IsNullOrWhiteSpace(AccessPassword);
}
