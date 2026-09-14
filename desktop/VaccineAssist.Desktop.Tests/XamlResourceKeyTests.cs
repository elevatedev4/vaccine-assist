using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Cheap, string/regex-based guard against a XamlParseException thrown out
/// of InitializeComponent by an undefined StaticResource/DynamicResource
/// key — this test project doesn't reference WPF (it's plain xunit; see
/// this project's own doc/history), so it can't actually load each .xaml
/// file the way the real app does at startup. Instead: every
/// {StaticResource X} / {DynamicResource X} reference anywhere under
/// VaccineAssist.Desktop must have a matching x:Key="X" the real app would
/// resolve it from — the same file, App.xaml's Application.Resources (in
/// scope everywhere), or a ResourceDictionary merged into either.
///
/// Prompted by the 2026-09-14 "signed in, but the main window couldn't be
/// opened" bug hunt (MainWindow resilience) — an undefined resource key on
/// MainWindow.xaml or one of its child views was one of the suspects for
/// what threw. None were found this round (LotsView.xaml's one
/// StaticResource use — LotsRowStyle — is defined locally), but this test
/// exists so a FUTURE one is caught at build time instead of only from a
/// field screenshot.
/// </summary>
public class XamlResourceKeyTests
{
    private static readonly Regex ResourceReferenceRegex = new(
        @"\{(?:StaticResource|DynamicResource)\s+(?<key>[^}\s,]+)\}",
        RegexOptions.Compiled);

    private static readonly Regex ResourceKeyDefinitionRegex = new(
        @"x:Key\s*=\s*""(?<key>[^""]+)""",
        RegexOptions.Compiled);

    private static readonly Regex MergedDictionarySourceRegex = new(
        @"<ResourceDictionary[^>]*\sSource\s*=\s*""(?<path>[^""]+)""",
        RegexOptions.Compiled);

    [Fact]
    public void EveryResourceKeyReferencedInXamlIsDefinedSomewhereItWouldResolve()
    {
        var projectDir = FindDesktopProjectDirectory();
        var xamlFiles = Directory.GetFiles(projectDir, "*.xaml", SearchOption.AllDirectories);

        // Guards the scan itself: if this ever returns nothing (e.g. the
        // path-walk logic silently landed in the wrong directory), every
        // assertion below would trivially pass for the wrong reason.
        Assert.True(xamlFiles.Length > 10, $"Expected many .xaml files under {projectDir}, found {xamlFiles.Length}.");

        var contentByFile = xamlFiles.ToDictionary(f => f, File.ReadAllText);

        // Global scope: keys defined directly in App.xaml (Application.Resources
        // is visible from every window/control in the app), plus keys from
        // any ResourceDictionary merged into ANY file — this app currently
        // has no merged dictionaries at all, but treating a merge target's
        // keys as globally visible is a safe over-approximation for a cheap
        // guard test like this one (it can only make the check more
        // permissive, never miss a real undefined key).
        var globalKeys = new HashSet<string>(StringComparer.Ordinal);

        var appXamlPath = xamlFiles.FirstOrDefault(f => Path.GetFileName(f) == "App.xaml");
        if (appXamlPath is not null)
        {
            CollectKeys(contentByFile[appXamlPath], globalKeys);
        }

        foreach (var (file, content) in contentByFile)
        {
            foreach (Match match in MergedDictionarySourceRegex.Matches(content))
            {
                var mergedPath = ResolveMergedPath(file, match.Groups["path"].Value);
                if (mergedPath is not null && contentByFile.TryGetValue(mergedPath, out var mergedContent))
                {
                    CollectKeys(mergedContent, globalKeys);
                }
            }
        }

        var missing = new List<string>();

        foreach (var (file, content) in contentByFile)
        {
            var localKeys = new HashSet<string>(StringComparer.Ordinal);
            CollectKeys(content, localKeys);

            foreach (Match match in ResourceReferenceRegex.Matches(content))
            {
                var key = match.Groups["key"].Value.Trim();
                if (!localKeys.Contains(key) && !globalKeys.Contains(key))
                {
                    missing.Add($"{Path.GetFileName(file)}: {{StaticResource/DynamicResource {key}}}");
                }
            }
        }

        Assert.True(missing.Count == 0,
            "Undefined StaticResource/DynamicResource key(s) found — these would throw a " +
            "XamlParseException at InitializeComponent on the real WPF runtime:" + Environment.NewLine +
            string.Join(Environment.NewLine, missing));
    }

    private static void CollectKeys(string xamlContent, HashSet<string> into)
    {
        foreach (Match match in ResourceKeyDefinitionRegex.Matches(xamlContent))
        {
            into.Add(match.Groups["key"].Value.Trim());
        }
    }

    private static string? ResolveMergedPath(string referencingFile, string relativeSource)
    {
        try
        {
            var dir = Path.GetDirectoryName(referencingFile)!;
            return Path.GetFullPath(Path.Combine(dir, relativeSource.Replace('/', Path.DirectorySeparatorChar)));
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Walks up from the test assembly's output directory (e.g.
    /// .../VaccineAssist.Desktop.Tests/bin/Debug/net8.0-windows/) until it
    /// finds a sibling "VaccineAssist.Desktop" project directory — avoids
    /// any hardcoded absolute/relative path that would differ between a
    /// local build and CI's windows-latest checkout.
    /// </summary>
    private static string FindDesktopProjectDirectory()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "VaccineAssist.Desktop");
            if (File.Exists(Path.Combine(candidate, "VaccineAssist.Desktop.csproj")))
            {
                return candidate;
            }
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            $"Couldn't locate the VaccineAssist.Desktop project directory by walking up from {AppContext.BaseDirectory}.");
    }
}
