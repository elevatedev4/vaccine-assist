using System;
using System.Diagnostics;
using System.IO;

namespace VaccineAssist.Desktop.Versioning;

/// <summary>The process to start for a version switch.</summary>
public sealed record LauncherCommand(string FileName, string Arguments, string WorkingDirectory);

/// <summary>
/// Builds (pure) and starts (thin) the detached launcher for a version
/// switch: powershell.exe -File &lt;primary&gt;\desktop\update-and-run.ps1 -Ref
/// &lt;ref&gt; -WaitForPid &lt;this process&gt;. The script waits for this process to
/// exit, then builds and starts the requested version. Nothing is persisted:
/// the desktop shortcut (no -Ref) always opens Stable.
/// </summary>
public static class VersionLauncher
{
    public const string ScriptRelativePath = @"desktop\update-and-run.ps1";

    public static LauncherCommand BuildCommand(string primaryRoot, string versionRef, int waitForPid)
    {
        if (string.IsNullOrWhiteSpace(primaryRoot))
        {
            throw new ArgumentException("Primary checkout path is required.", nameof(primaryRoot));
        }
        if (!TestingBranchParser.IsLaunchableRef(versionRef))
        {
            throw new ArgumentException($"Not a launchable version ref: '{versionRef}'.", nameof(versionRef));
        }

        var script = primaryRoot.TrimEnd('\\', '/') + "\\" + ScriptRelativePath;
        var args =
            $"-NoProfile -ExecutionPolicy Bypass -File \"{script}\" -Ref \"{versionRef}\" -WaitForPid {waitForPid}";
        return new LauncherCommand("powershell.exe", args, primaryRoot);
    }

    /// <summary>Starts the launcher in its own console window, detached from this process. Throws on failure.</summary>
    public static void Start(LauncherCommand command)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = command.FileName,
            Arguments = command.Arguments,
            WorkingDirectory = Directory.Exists(command.WorkingDirectory) ? command.WorkingDirectory : "",
            UseShellExecute = true, // own console window so build progress/errors are visible
        };
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("The launcher process could not be started.");
    }
}
