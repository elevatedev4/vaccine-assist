using System;
using System.Text.Json;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Reads the "exp" claim out of a Supabase access token (a JWT) WITHOUT
/// verifying it — this is only used to decide "is it time to refresh?",
/// never to trust the token (the cloud API verifies it on every call).
/// Anything that doesn't parse returns null, which SessionKeeper treats
/// as "expiry unknown — refresh to be safe".
/// </summary>
public static class JwtExpiry
{
    public static DateTime? TryGetExpiryUtc(string? jwt)
    {
        if (string.IsNullOrWhiteSpace(jwt))
        {
            return null;
        }

        var parts = jwt.Split('.');
        if (parts.Length != 3)
        {
            return null;
        }

        try
        {
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            using var doc = JsonDocument.Parse(Convert.FromBase64String(payload));
            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                doc.RootElement.TryGetProperty("exp", out var exp) &&
                exp.ValueKind == JsonValueKind.Number &&
                exp.TryGetInt64(out var seconds))
            {
                return DateTimeOffset.FromUnixTimeSeconds(seconds).UtcDateTime;
            }
        }
        catch (Exception)
        {
            // Malformed token — fall through to "unknown".
        }

        return null;
    }
}
