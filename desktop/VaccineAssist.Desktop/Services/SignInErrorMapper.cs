using System;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Single funnel for every raw error string that could otherwise reach
/// the Login screen's ErrorMessage TextBlock verbatim (Will, 2026-09-16:
/// "On signin screen on desktop, it's returning errors in an ugly format,
/// needs to be user friendly"). Before this existed, LoginViewModel and
/// SupabaseAuthService both interpolated raw exception messages
/// (ex.Message from Supabase.Gotrue/HttpClient/etc.) straight into
/// ErrorMessage — technical, sometimes JSON-shaped text a pharmacy
/// employee has no way to act on.
///
/// Pure and stateless by design (no AppFileLog/file I/O in here) so it's
/// trivially unit-testable with synthetic strings — see
/// SignInErrorMapperTests.cs. Callers are still responsible for logging
/// the RAW message/exception to AppFileLog themselves before or after
/// calling Map; this class only ever produces what the USER sees.
/// </summary>
public static class SignInErrorMapper
{
    /// <summary>Shared with LoginViewModel.SignInTimeout — the same
    /// wording covers both "the sign-in call timed out" and "the sign-in
    /// call failed with a network-shaped error," since neither is
    /// something the user can distinguish or act on differently.</summary>
    public const string NetworkOrTimeoutMessage =
        "Couldn't reach the sign-in service — check the internet connection and try again.";

    public const string InvalidCredentialsMessage = "Email or password is incorrect.";

    private const int MaxShortReasonLength = 60;

    /// <summary>
    /// Maps a raw error message (from an AuthResult.ErrorMessage or an
    /// Exception.Message) to plain English. Never returns raw
    /// JSON/stack-trace-shaped text — anything not recognized falls back
    /// to "Sign-in failed (&lt;short reason&gt;)" with the reason capped
    /// at <see cref="MaxShortReasonLength"/> characters, not the full raw
    /// text.
    /// </summary>
    public static string Map(string? rawMessage)
    {
        if (string.IsNullOrWhiteSpace(rawMessage))
        {
            return "Sign-in failed.";
        }

        var trimmed = rawMessage.Trim();
        var lower = trimmed.ToLowerInvariant();

        // This app's own "not configured yet" message (SupabaseAuthService's
        // early-return when SupabaseUrl/SupabaseAnonKey are blank) is
        // already plain English written by this codebase, not a raw
        // exception — pass it through unchanged rather than re-wrapping it
        // in "Sign-in failed (...)".
        if (lower.Contains("supabase is not configured"))
        {
            return trimmed;
        }

        if (IsInvalidCredentialsMessage(lower))
        {
            return InvalidCredentialsMessage;
        }

        if (IsNetworkOrTimeoutMessage(lower))
        {
            return NetworkOrTimeoutMessage;
        }

        return $"Sign-in failed ({Shorten(trimmed)}).";
    }

    private static bool IsInvalidCredentialsMessage(string lower) =>
        lower.Contains("invalid login credentials") ||
        lower.Contains("invalid_grant") ||
        lower.Contains("invalid credentials") ||
        lower.Contains("invalid email or password") ||
        lower.Contains("email not confirmed");

    private static bool IsNetworkOrTimeoutMessage(string lower) =>
        lower.Contains("timed out") ||
        lower.Contains("timeout") ||
        lower.Contains("could not resolve host") ||
        lower.Contains("no such host") ||
        lower.Contains("name resolution") ||
        lower.Contains("network is unreachable") ||
        lower.Contains("connection refused") ||
        lower.Contains("connection reset") ||
        lower.Contains("unable to connect") ||
        lower.Contains("the operation was canceled") ||
        lower.Contains("operation canceled") ||
        lower.Contains("was canceled") ||
        lower.Contains("was cancelled") ||
        lower.Contains("httprequestexception") ||
        lower.Contains("socketexception") ||
        lower.Contains("no internet") ||
        lower.Contains("ssl connection could not be established");

    /// <summary>
    /// Strips this app's own "Sign-in failed: " / "Session restore failed: "
    /// prefixes (SupabaseAuthService's catch blocks add these) before
    /// shortening, so the fallback message never doubles up
    /// ("Sign-in failed (Sign-in failed: ...)").
    /// </summary>
    private static string Shorten(string message)
    {
        var text = message;
        foreach (var prefix in new[] { "Sign-in failed: ", "Session restore failed: " })
        {
            if (text.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                text = text[prefix.Length..];
                break;
            }
        }

        // A raw exception's Message property alone doesn't usually carry
        // its own type name, but some libraries' messages (or a caller
        // that interpolated ex.ToString() instead of ex.Message) do —
        // "System.Foo.BarException: the actual reason." Strip through the
        // LAST "Exception: " marker so a .NET type name never becomes
        // part of the short reason the user sees.
        const string exceptionMarker = "Exception: ";
        var markerIndex = text.LastIndexOf(exceptionMarker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex >= 0)
        {
            text = text[(markerIndex + exceptionMarker.Length)..];
        }

        text = text.Trim();
        return text.Length <= MaxShortReasonLength ? text : text[..MaxShortReasonLength] + "…";
    }
}
