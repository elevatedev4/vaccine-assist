using System;
using System.Collections.Generic;
using System.Linq;

namespace VaccineAssist.Desktop.Versioning;

/// <summary>What the remote testing-branch lookup currently knows.</summary>
public enum TestingVersionsStatus
{
    /// <summary>No answer yet — a lookup is running or hasn't started.</summary>
    Loading,
    /// <summary>git answered; Refs may still be empty (no testing branches exist).</summary>
    Loaded,
    /// <summary>git missing, offline, or timed out.</summary>
    Unavailable,
}

public sealed record TestingVersionsSnapshot(TestingVersionsStatus Status, IReadOnlyList<string> Refs)
{
    public static TestingVersionsSnapshot Loading { get; } = new(TestingVersionsStatus.Loading, Array.Empty<string>());
    public static TestingVersionsSnapshot Unavailable { get; } = new(TestingVersionsStatus.Unavailable, Array.Empty<string>());
}

/// <summary>One row of the "Version" submenu. Ref is null for informational disabled rows.</summary>
public sealed record VersionMenuItem(string Text, bool Enabled, bool Checked, string? Ref);

/// <summary>
/// Pure description of the "Version" submenu shared by the tray menu and the
/// Pioneer overlay menu: first row "Stable (default)", then one row per
/// remote testing branch, current one checked.
/// </summary>
public static class VersionMenuBuilder
{
    public const string StableText = "Stable (default)";
    public const string NoTestingText = "No testing versions available";
    public const string LoadingText = "Checking for testing versions…";

    public static IReadOnlyList<VersionMenuItem> Build(BuildInfo current, TestingVersionsSnapshot snapshot)
    {
        var items = new List<VersionMenuItem>
        {
            new(StableText, true, !current.IsTesting, BuildInfo.StableRef),
        };

        // The version we are running always gets a row even if its branch
        // has since been deleted from origin, so the checkmark is never lost.
        var refs = new List<string>(snapshot.Refs);
        if (current.IsTesting && !refs.Contains(current.Ref, StringComparer.Ordinal))
        {
            refs.Add(current.Ref);
        }

        foreach (var testingRef in refs)
        {
            items.Add(new VersionMenuItem(
                RowText(testingRef), true, string.Equals(testingRef, current.Ref, StringComparison.Ordinal), testingRef));
        }

        if (!snapshot.Refs.Any())
        {
            if (snapshot.Status == TestingVersionsStatus.Loading && !current.IsTesting)
            {
                items.Add(new VersionMenuItem(LoadingText, false, false, null));
            }
            else if (!refs.Any())
            {
                items.Add(new VersionMenuItem(NoTestingText, false, false, null));
            }
        }

        return items;
    }

    public static string RowText(string testingRef) =>
        $"Testing — {testingRef.Substring(BuildInfo.TestingPrefix.Length)}";

    /// <summary>Name used in the switch-confirmation sentence.</summary>
    public static string DisplayName(string versionRef) =>
        BuildInfo.IsTestingRef(versionRef)
            ? $"Testing: {versionRef.Substring(BuildInfo.TestingPrefix.Length)}"
            : "Stable";

    public static string ConfirmMessage(string versionRef) =>
        $"Switch to {DisplayName(versionRef)}? Vaccine Assist will restart. The desktop shortcut always opens Stable.";
}
