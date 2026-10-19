using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace VaccineAssist.Desktop.Versioning;

/// <summary>
/// Parses `git ls-remote --heads origin "refs/heads/testing/*"` output into
/// testing refs ("testing/&lt;slug&gt;"). Also the single validity check for a
/// ref name that is about to be handed to the launcher's command line, so a
/// hostile or odd branch name can never inject arguments.
/// </summary>
public static class TestingBranchParser
{
    private const string HeadsPrefix = "refs/heads/";

    // testing/<slug>: one path segment, starts alphanumeric, then
    // alphanumerics . _ - only. Matches the launcher script's own check.
    private static readonly Regex ValidTestingRef = new(
        @"^testing/[A-Za-z0-9][A-Za-z0-9._-]*\z", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    // Windows device names cannot be created as ref files there (con, aux, nul, com1, ...).
    private static readonly Regex WindowsReservedName = new(
        @"^(con|prn|aux|nul|com[1-9]|lpt[1-9])\z", RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    public static bool IsValidTestingRef(string? value)
    {
        if (value is null
            || !ValidTestingRef.IsMatch(value)
            || value.Contains("..", StringComparison.Ordinal)
            || value.EndsWith(".lock", StringComparison.Ordinal)
            || value.EndsWith(".", StringComparison.Ordinal))
        {
            return false;
        }

        var slug = value.Substring(BuildInfo.TestingPrefix.Length);
        var baseName = slug.Split('.')[0];
        return !WindowsReservedName.IsMatch(baseName);
    }

    /// <summary>A ref the launcher may be asked to run: "stable" or a valid testing ref.</summary>
    public static bool IsLaunchableRef(string? value) =>
        string.Equals(value, BuildInfo.StableRef, StringComparison.Ordinal) || IsValidTestingRef(value);

    /// <summary>Sorted, de-duplicated testing refs; malformed lines and invalid names are skipped.</summary>
    public static IReadOnlyList<string> ParseLsRemote(string? output)
    {
        if (string.IsNullOrWhiteSpace(output))
        {
            return Array.Empty<string>();
        }

        var refs = new HashSet<string>(StringComparer.Ordinal);
        foreach (var rawLine in output.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0) continue;

            var parts = line.Split(new[] { '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 2) continue;

            var sha = parts[0];
            var fullRef = parts[1];
            if (sha.Length < 7 || !sha.All(Uri.IsHexDigit)) continue;
            if (!fullRef.StartsWith(HeadsPrefix, StringComparison.Ordinal)) continue;

            var branch = fullRef.Substring(HeadsPrefix.Length);
            if (IsValidTestingRef(branch))
            {
                refs.Add(branch);
            }
        }

        return refs.OrderBy(r => r, StringComparer.OrdinalIgnoreCase).ToArray();
    }
}
