using System;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Pure text for the Notifyre API token's "is something actually saved"
/// line in Fax settings (Will, 2026-09-28, verbatim: "we need to make
/// sure the settings is storing the Notifyre key, not just using it for
/// testing. Currently it doesn't show that in the settings that it
/// is.") — never shows the token itself, just enough to recognize it
/// (its last 4 characters) plus when it was last (re)saved. Pure/static
/// so it's directly unit-testable with synthetic values, independent of
/// FaxSettingsViewModel's WPF-adjacent dependencies.
/// </summary>
public static class FaxKeyStatus
{
    /// <summary>"No key saved" when <paramref name="storedLast4"/> is
    /// blank; otherwise "Notifyre key saved (ends &#8230;1234, saved
    /// 2026-09-28 19:20)". <paramref name="savedAtUtc"/> is rendered in
    /// LOCAL time (Will reads this on his own PC) — "unknown time" for a
    /// key stored before this field existed rather than a blank/
    /// misleading date.</summary>
    public static string Describe(string? storedLast4, DateTime? savedAtUtc)
    {
        if (string.IsNullOrWhiteSpace(storedLast4))
        {
            return "No key saved";
        }

        var when = savedAtUtc is { } utc
            ? utc.ToLocalTime().ToString("yyyy-MM-dd HH:mm")
            : "unknown time";

        return $"Notifyre key saved (ends …{storedLast4}, saved {when})";
    }

    /// <summary>Last 4 characters of a token (NOT digits-only — Notifyre
    /// tokens are opaque strings, not phone numbers), or "" for a
    /// blank/absent token. Shorter-than-4 tokens show in full (still
    /// never the WHOLE token for anything realistic-length, but there's
    /// nothing shorter to hide).</summary>
    public static string Last4OfToken(string? token)
    {
        if (string.IsNullOrEmpty(token)) return "";
        return token.Length <= 4 ? token : token[^4..];
    }
}
