using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// DPAPI-protected store for BOTH vendors' fax credentials (SRFax access
/// id/password, Notifyre's API token — see FaxCredentials), parallel to
/// Settings/SessionStore.cs — %LocalAppData%\VaccineAssist\fax\credentials.json,
/// ProtectedData.Protect(..., DataProtectionScope.CurrentUser), never
/// plaintext on disk, never in settings.json (see AppSettings.Fax's doc
/// comment on why). Tolerant by design: a missing file, corrupt JSON, or a
/// DPAPI failure (e.g. copied to a different machine/user profile) all
/// mean "no credentials stored" rather than a crash — the Settings
/// window's fields are simply blank until re-entered. A field that was
/// simply never saved (e.g. ApiToken on an install that's only ever used
/// SRFax, or AccessId/AccessPassword on a fresh Notifyre-only install)
/// loads as "" rather than making the whole record fail to load — only an
/// actually-corrupt/undecryptable protected value does that.
/// </summary>
public sealed class FaxCredentialStore : IFaxCredentialStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly string _filePath;

    public FaxCredentialStore()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "VaccineAssist", "fax", "credentials.json"))
    {
    }

    /// <summary>Injectable seam for unit tests.</summary>
    public FaxCredentialStore(string filePath)
    {
        _filePath = filePath;
    }

    public FaxCredentials? Load()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return null;
            }

            var json = File.ReadAllText(_filePath);
            var dto = JsonSerializer.Deserialize<CredentialsFileDto>(json);
            if (dto is null)
            {
                return null;
            }

            // Blank/absent (never saved for this vendor) -> "" ; present
            // but undecryptable (corrupt file, or moved to another
            // machine/user) -> null, which fails the WHOLE load below —
            // matches SessionStore's same distinction.
            var accessId = UnprotectIfPresent(dto.AccessIdProtected);
            var accessPassword = UnprotectIfPresent(dto.AccessPasswordProtected);
            var apiToken = UnprotectIfPresent(dto.ApiTokenProtected);
            if (accessId is null || accessPassword is null || apiToken is null)
            {
                return null;
            }

            return new FaxCredentials { AccessId = accessId, AccessPassword = accessPassword, ApiToken = apiToken };
        }
        catch
        {
            return null;
        }
    }

    public void Save(FaxCredentials credentials)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var dto = new CredentialsFileDto
        {
            AccessIdProtected = Protect(credentials.AccessId),
            AccessPasswordProtected = Protect(credentials.AccessPassword),
            ApiTokenProtected = Protect(credentials.ApiToken),
        };

        var json = JsonSerializer.Serialize(dto, JsonOptions);
        File.WriteAllText(_filePath, json);
    }

    public void Delete()
    {
        try
        {
            if (File.Exists(_filePath))
            {
                File.Delete(_filePath);
            }
        }
        catch
        {
            // Best-effort, matches SessionStore.Delete.
        }
    }

    private static string Protect(string plainText)
    {
        var plainBytes = Encoding.UTF8.GetBytes(plainText);
        var protectedBytes = ProtectedData.Protect(plainBytes, optionalEntropy: null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(protectedBytes);
    }

    private static string? Unprotect(string base64)
    {
        try
        {
            var protectedBytes = Convert.FromBase64String(base64);
            var plainBytes = ProtectedData.Unprotect(protectedBytes, optionalEntropy: null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plainBytes);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>"" for a blank/absent protected value (this vendor's
    /// field was never saved) — only a NON-blank value that fails to
    /// Unprotect returns null (genuinely corrupt/undecryptable).</summary>
    private static string? UnprotectIfPresent(string? base64) =>
        string.IsNullOrWhiteSpace(base64) ? "" : Unprotect(base64);

    private sealed class CredentialsFileDto
    {
        public string AccessIdProtected { get; set; } = "";
        public string AccessPasswordProtected { get; set; } = "";
        public string ApiTokenProtected { get; set; } = "";
    }
}
