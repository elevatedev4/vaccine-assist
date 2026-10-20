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
/// </summary>
public static class AgeMacroCodesUrlBuilder
{
    public static string BuildUrl(string? cloudApiBaseUrl, int ageYears)
    {
        var baseUrl = (cloudApiBaseUrl ?? string.Empty).TrimEnd('/');
        return $"{baseUrl}/macro-codes?embed=1&age={ageYears}";
    }
}
