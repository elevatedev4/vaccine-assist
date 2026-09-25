namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Pure URL-building for the Ctrl+Keypad 4 age-filtered macro-codes flow
/// (Will's brief, 2026-09-25) — kept separate from MacroCodesWindow (a
/// real WPF Window/WebView2 host) so it's covered by fast xUnit tests,
/// same split as AgePromptInput above. Mirrors MacroCodesWindow's own
/// (private) BuildMacroCodesUrl helper — same base-URL-trim and
/// /macro-codes?embed=1 prefix — but appends the age-filter query params
/// the cloud side's /macro-codes route accepts alongside embed=1:
/// age=&lt;years&gt; always, plus an optional &amp;ageMonths=&lt;n&gt;
/// for a finer under-2 filter. If the cloud route's exact param name
/// ever changes, this is the one place to update — MacroCodesWindow
/// itself just takes the finished URL (see its overrideUrl constructor
/// parameter).
/// </summary>
public static class AgeMacroCodesUrlBuilder
{
    public static string BuildUrl(string? cloudApiBaseUrl, int ageYears, int? ageMonths)
    {
        var baseUrl = (cloudApiBaseUrl ?? string.Empty).TrimEnd('/');
        var url = $"{baseUrl}/macro-codes?embed=1&age={ageYears}";

        if (ageMonths is int months)
        {
            url += $"&ageMonths={months}";
        }

        return url;
    }
}
