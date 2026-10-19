using System;
using System.IO;

namespace VaccineAssist.Desktop.Versioning;

/// <summary>
/// Finds the PRIMARY checkout (the one the desktop shortcut's launcher
/// script lives in). A testing build runs from a sibling worktree folder
/// (&lt;primary&gt;-testing), but git operations and the launcher must always
/// target the primary one.
/// </summary>
public static class PrimaryCheckoutLocator
{
    public const string TestingFolderSuffix = "-testing";

    /// <param name="stampedRoot">VaPrimaryRoot stamped by update-and-run.ps1 (may be empty).</param>
    /// <param name="baseDirectory">AppContext.BaseDirectory of the running exe.</param>
    /// <param name="directoryExists">Injected for tests.</param>
    /// <param name="gitMarkerExists">True when the folder has a .git file or directory; injected for tests.</param>
    public static string? Resolve(
        string? stampedRoot,
        string baseDirectory,
        Func<string, bool> directoryExists,
        Func<string, bool> gitMarkerExists)
    {
        if (!string.IsNullOrWhiteSpace(stampedRoot) && directoryExists(stampedRoot))
        {
            return stampedRoot;
        }

        var dir = baseDirectory.TrimEnd('\\', '/');
        while (!string.IsNullOrEmpty(dir))
        {
            if (gitMarkerExists(dir))
            {
                return StripTestingSuffix(dir, directoryExists);
            }

            var parent = Path.GetDirectoryName(dir);
            if (string.IsNullOrEmpty(parent) || string.Equals(parent, dir, StringComparison.Ordinal))
            {
                break;
            }
            dir = parent;
        }

        return null;
    }

    /// <summary>Production overload using the real file system.</summary>
    public static string? ResolveForCurrentProcess() =>
        Resolve(
            BuildInfo.Current.PrimaryRoot,
            AppContext.BaseDirectory,
            Directory.Exists,
            d => Directory.Exists(Path.Combine(d, ".git")) || File.Exists(Path.Combine(d, ".git")));

    private static string StripTestingSuffix(string dir, Func<string, bool> directoryExists)
    {
        if (dir.EndsWith(TestingFolderSuffix, StringComparison.OrdinalIgnoreCase))
        {
            var candidate = dir.Substring(0, dir.Length - TestingFolderSuffix.Length);
            if (candidate.Length > 0 && directoryExists(candidate))
            {
                return candidate;
            }
        }
        return dir;
    }
}
