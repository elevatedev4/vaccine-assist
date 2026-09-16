using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for SignInErrorMapper — the single funnel every raw
/// error string is routed through before reaching the Login screen
/// (Will, 2026-09-16: "it's returning errors in an ugly format, needs to
/// be user friendly"). Synthetic inputs only, per the brief — no real
/// Supabase/HttpClient exception text captured here, just message shapes
/// those libraries are known to produce.
/// </summary>
public class SignInErrorMapperTests
{
    [Theory]
    [InlineData("Sign-in failed: Invalid login credentials")]
    [InlineData("invalid_grant")]
    [InlineData("Invalid login credentials")]
    [InlineData("AuthApiException: invalid credentials")]
    [InlineData("Email not confirmed")]
    public void MapsWrongPasswordShapedMessagesToPlainEnglish(string raw)
    {
        Assert.Equal(SignInErrorMapper.InvalidCredentialsMessage, SignInErrorMapper.Map(raw));
    }

    [Theory]
    [InlineData("The operation has timed out.")]
    [InlineData("A task was canceled.")]
    [InlineData("System.Net.Http.HttpRequestException: Connection refused")]
    [InlineData("No such host is known.")]
    [InlineData("System.Net.Sockets.SocketException (11001): No such host is known")]
    [InlineData("Name or service not known (name resolution failed)")]
    public void MapsNetworkAndTimeoutShapedMessagesToTheSameFriendlyMessage(string raw)
    {
        Assert.Equal(SignInErrorMapper.NetworkOrTimeoutMessage, SignInErrorMapper.Map(raw));
    }

    [Fact]
    public void PassesThroughTheAppsOwnNotConfiguredMessageUnchanged()
    {
        const string raw =
            "Supabase is not configured yet (SupabaseUrl/SupabaseAnonKey are blank in " +
            "%AppData%\\VaccineAssist\\settings.json). This is expected until a real Supabase " +
            "project exists — phase 1 has no live database calls.";

        Assert.Equal(raw, SignInErrorMapper.Map(raw));
    }

    [Fact]
    public void FallsBackToAShortGenericReasonForAnythingUnrecognized()
    {
        var result = SignInErrorMapper.Map("System.NullReferenceException: Object reference not set to an instance of an object.");

        Assert.StartsWith("Sign-in failed (", result);
        Assert.DoesNotContain("NullReferenceException", result);
    }

    [Fact]
    public void StripsThisAppsOwnSignInFailedPrefixBeforeShortening()
    {
        var result = SignInErrorMapper.Map("Sign-in failed: some genuinely unrecognized backend error");

        // Must not double up the phrase ("Sign-in failed (Sign-in failed: ...)").
        Assert.Equal("Sign-in failed (some genuinely unrecognized backend error).", result);
    }

    [Fact]
    public void TruncatesAVeryLongUnrecognizedMessage()
    {
        var longMessage = new string('x', 200);

        var result = SignInErrorMapper.Map(longMessage);

        Assert.True(result.Length < longMessage.Length);
        Assert.Contains("…", result);
    }

    [Fact]
    public void NullOrWhitespaceMapsToAPlainGenericMessage()
    {
        Assert.Equal("Sign-in failed.", SignInErrorMapper.Map(null));
        Assert.Equal("Sign-in failed.", SignInErrorMapper.Map("   "));
    }

    [Fact]
    public void NeverReturnsRawJsonOrStackTraceShapedText()
    {
        var raw = "{\"error\":\"invalid_grant\",\"error_description\":\"Invalid login credentials\"}";

        var result = SignInErrorMapper.Map(raw);

        // The raw braces/JSON never survive the mapping — either the
        // invalid-credentials branch matched or the fallback shortened it,
        // but the ugly raw shape is gone from what reaches the user.
        Assert.DoesNotContain("{", result);
    }
}
