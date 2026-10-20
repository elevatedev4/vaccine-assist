namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Pure URL-building for the Ctrl+Keypad 2 age-filtered macro-codes flow
/// (originally Ctrl+Keypad 4, re-keyed same day — Will's brief,
/// 2026-09-25) — kept separate from MacroCodesWindow (a
/// real WPF Window/WebView2 host) so it's covered by fast xUnit tests,
/// same split as AgePromptInput above. Mirrors MacroCodesWindow's own
/// (private) BuildMacroCodesUrl helper — same base-URL-trim and
/// /macro-codes?embed=1 prefix — but appends the age-filter query param
/// the cloud side's /macro-codes route accepts alongside embed=1:
/// age=&lt;years&gt;. If the cloud route's exact param name ever changes,
/// this is the one place to update — MacroCodesWindow itself just takes
/// the finished URL (see its overrideUrl constructor parameter).
///
/// 2026-09-25 round 2 (Will, verbatim): "We don't vaccicne less than age
/// 3, so remove the months indicator." The desktop no longer sends
/// ageMonths — the cloud route still accepts it as optional, but nothing
/// here supplies it.
///
/// 2026-10-20 (V-Q11, testing version "flu-preferred"): every macro-codes URL
/// the testing desktop opens carries <see cref="HotkeyProfileQuery"/>
/// (hk=flu2). The cloud page only switches to the new hotkeys (F = the
/// recommended flu for the age, X Flucelvax, D Fluad, V mFLUSIVA, C = the
/// preferred COVID vaccine from the location settings) when it sees that
/// param, so the stable desktop and a browser keep the classic letters.
/// An older cloud simply ignores the param.
/// </summary>
public static class AgeMacroCodesUrlBuilder
{
    /// <summary>Query pair that opts the cloud macro-codes page into the flu2 hotkey profile.</summary>
    public const string HotkeyProfileQuery = "hk=flu2";

    public static string BuildUrl(string? cloudApiBaseUrl, int ageYears)
    {
        var baseUrl = (cloudApiBaseUrl ?? string.Empty).TrimEnd('/');
        return $"{baseUrl}/macro-codes?embed=1&age={ageYears}&{HotkeyProfileQuery}";
    }

    /// <summary>The plain Ctrl+Keypad 8 URL (no age filter). F and C show a "needs the age" message there.</summary>
    public static string BuildUrlWithoutAge(string? cloudApiBaseUrl)
    {
        var baseUrl = (cloudApiBaseUrl ?? string.Empty).TrimEnd('/');
        return $"{baseUrl}/macro-codes?embed=1&{HotkeyProfileQuery}";
    }
}
