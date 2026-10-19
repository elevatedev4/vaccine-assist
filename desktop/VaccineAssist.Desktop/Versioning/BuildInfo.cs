using System;
using System.Linq;
using System.Reflection;

namespace VaccineAssist.Desktop.Versioning;

/// <summary>
/// Which git ref this build was made from. update-and-run.ps1 stamps it at
/// build time (dotnet build -p:VaBuildRef=... -p:VaBuildCommit=...
/// -p:VaPrimaryRoot=..., turned into AssemblyMetadata attributes by the
/// csproj), so the running app always knows whether it is Stable or a
/// Testing version. A build that was never stamped (IDE/CI build, or the
/// OLD launcher script that passes nothing) reads as Stable — the safe
/// default: stable behavior and the plain "Vaccine Assist" title.
///
/// WPF-free on purpose so the title/menu logic is unit-testable.
/// </summary>
public sealed record BuildInfo(string Ref, string Commit, string PrimaryRoot)
{
    public const string StableRef = "stable";
    public const string TestingPrefix = "testing/";
    private const string UnstampedSentinel = "unstamped";

    /// <summary>True for refs of the form testing/&lt;slug&gt;.</summary>
    public bool IsTesting => IsTestingRef(Ref);

    /// <summary>The part after testing/ (empty when not a testing build).</summary>
    public string Slug => IsTesting ? Ref.Substring(TestingPrefix.Length) : "";

    public string Channel => IsTesting ? "testing" : "stable";

    /// <summary>Main window title: stable = "Vaccine Assist"; testing = "Vaccine Assist — TESTING: &lt;slug&gt;".</summary>
    public string WindowTitle => IsTesting ? $"Vaccine Assist — TESTING: {Slug}" : "Vaccine Assist";

    /// <summary>Tray tooltip base text (Windows caps NotifyIcon.Text at 63 chars).</summary>
    public string TrayTooltip
    {
        get
        {
            var text = IsTesting ? $"Vaccine Assist [TESTING: {Slug}]" : "Vaccine Assist";
            return text.Length <= 40 ? text : text.Substring(0, 40);
        }
    }

    /// <summary>One log line's worth: "testing/flu-preferred @ 1a2b3c4".</summary>
    public string Describe() =>
        $"{(string.IsNullOrEmpty(Ref) ? "unstamped" : Ref)} @ {(string.IsNullOrEmpty(Commit) ? "unknown" : Commit)}";

    public static bool IsTestingRef(string? value) =>
        value is not null && value.StartsWith(TestingPrefix, StringComparison.Ordinal) && value.Length > TestingPrefix.Length;

    private static BuildInfo? _current;

    /// <summary>The stamp on the running assembly (cached).</summary>
    public static BuildInfo Current => _current ??= FromAssembly(typeof(BuildInfo).Assembly);

    public static BuildInfo FromAssembly(Assembly assembly)
    {
        string Read(string key)
        {
            var value = assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                .FirstOrDefault(a => string.Equals(a.Key, key, StringComparison.Ordinal))?.Value;
            return Normalize(value);
        }

        return new BuildInfo(Read("VaBuildRef"), Read("VaBuildCommit"), Read("VaPrimaryRoot"));
    }

    /// <summary>The csproj stamps "unstamped" when no property was passed; that, and null, mean "no value".</summary>
    public static string Normalize(string? raw)
    {
        var trimmed = raw?.Trim() ?? "";
        return string.Equals(trimmed, UnstampedSentinel, StringComparison.OrdinalIgnoreCase) ? "" : trimmed;
    }
}
