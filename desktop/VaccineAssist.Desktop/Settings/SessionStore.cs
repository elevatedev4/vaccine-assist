using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace VaccineAssist.Desktop.Settings;

/// <summary>
/// Persists the 90-day sign-in (Will, 2026-09-13) at
/// %LocalAppData%\VaccineAssist\session.json. The access/refresh tokens
/// are encrypted at rest with DPAPI (System.Security.Cryptography.
/// ProtectedData, DataProtectionScope.CurrentUser — decryptable only by
/// the same Windows user account on the same machine, no password of our
/// own to manage) before being base64-encoded into the JSON file;
/// IssuedAtUtc is stored in the clear since it isn't secret and
/// SessionExpiry needs to read it without decrypting anything.
///
/// Tolerant by design, matching AutoLoginConfigService/LocalSettingsService:
/// a missing file, corrupt JSON, or a DPAPI failure (e.g. the file was
/// copied to a different machine or user profile, so CurrentUser-scoped
/// Unprotect can't decrypt it) all mean "no persisted session" rather
/// than a startup crash — the normal autologin.json / manual-login
/// fallbacks take over from there (see LoginViewModel.TrySilentSignInAsync).
/// </summary>
public sealed class SessionStore : ISessionStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly string _filePath;

    public SessionStore()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "VaccineAssist",
            "session.json"))
    {
    }

    /// <summary>Injectable seam for unit tests — points at an arbitrary file
    /// path instead of the real %LocalAppData% location.</summary>
    public SessionStore(string filePath)
    {
        _filePath = filePath;
    }

    public PersistedSession? Load()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return null;
            }

            var json = File.ReadAllText(_filePath);
            var dto = JsonSerializer.Deserialize<SessionFileDto>(json);
            if (dto is null ||
                string.IsNullOrWhiteSpace(dto.AccessTokenProtected) ||
                string.IsNullOrWhiteSpace(dto.RefreshTokenProtected))
            {
                return null;
            }

            var accessToken = Unprotect(dto.AccessTokenProtected);
            var refreshToken = Unprotect(dto.RefreshTokenProtected);
            if (accessToken is null || refreshToken is null)
            {
                return null;
            }

            return new PersistedSession(accessToken, refreshToken, dto.IssuedAtUtc);
        }
        catch
        {
            // Corrupt/unreadable/undecryptable file — treat exactly like
            // "nothing persisted" rather than blocking startup.
            return null;
        }
    }

    public void Save(PersistedSession session)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var dto = new SessionFileDto
        {
            AccessTokenProtected = Protect(session.AccessToken),
            RefreshTokenProtected = Protect(session.RefreshToken),
            IssuedAtUtc = session.IssuedAtUtc,
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
            // Best-effort — a stale, undeletable file (locked/permissions)
            // must not stop sign-out from completing; worst case it's
            // simply overwritten on the next successful sign-in/restore.
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

    /// <summary>On-disk JSON shape — kept private/separate from
    /// PersistedSession so the public model always holds decrypted
    /// plaintext and callers can never accidentally serialize the
    /// protected form somewhere else.</summary>
    private sealed class SessionFileDto
    {
        public string AccessTokenProtected { get; set; } = "";
        public string RefreshTokenProtected { get; set; } = "";
        public DateTime IssuedAtUtc { get; set; }
    }
}
