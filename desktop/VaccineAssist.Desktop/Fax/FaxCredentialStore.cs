using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// DPAPI-protected store for the SRFax access id/password, parallel to
/// Settings/SessionStore.cs — %LocalAppData%\VaccineAssist\fax\credentials.json,
/// ProtectedData.Protect(..., DataProtectionScope.CurrentUser), never
/// plaintext on disk, never in settings.json (see AppSettings.Fax's doc
/// comment on why). Tolerant by design: a missing file, corrupt JSON, or a
/// DPAPI failure (e.g. copied to a different machine/user profile) all
/// mean "no credentials stored" rather than a crash — the Settings
/// window's fields are simply blank until re-entered.
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
            if (dto is null ||
                string.IsNullOrWhiteSpace(dto.AccessIdProtected) ||
                string.IsNullOrWhiteSpace(dto.AccessPasswordProtected))
            {
                return null;
            }

            var accessId = Unprotect(dto.AccessIdProtected);
            var accessPassword = Unprotect(dto.AccessPasswordProtected);
            if (accessId is null || accessPassword is null)
            {
                return null;
            }

            return new FaxCredentials { AccessId = accessId, AccessPassword = accessPassword };
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

    private sealed class CredentialsFileDto
    {
        public string AccessIdProtected { get; set; } = "";
        public string AccessPasswordProtected { get; set; } = "";
    }
}
