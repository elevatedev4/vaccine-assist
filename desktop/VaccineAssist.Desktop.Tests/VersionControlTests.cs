using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Versioning;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>Version control: build info/title, Version submenu rows, ls-remote parsing, launcher command line, checkout location, catalog. All synthetic.</summary>
public class VersionControlTests
{
    private const string Sha = "0124dc7a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e";

    // ---- BuildInfo / title ----

    [Fact]
    public void StableBuildHasPlainTitle()
    {
        var info = new BuildInfo("stable", "abc1234", @"C:\x\vaccine-assist");
        Assert.False(info.IsTesting);
        Assert.Equal("Vaccine Assist", info.WindowTitle);
        Assert.Equal("stable", info.Channel);
    }

    [Fact]
    public void UnstampedBuildReadsAsStable()
    {
        var info = new BuildInfo(BuildInfo.Normalize("unstamped"), BuildInfo.Normalize("unstamped"), BuildInfo.Normalize(null));
        Assert.False(info.IsTesting);
        Assert.Equal("Vaccine Assist", info.WindowTitle);
        Assert.Equal("", info.Ref);
    }

    [Fact]
    public void MainFallbackBuildReadsAsStable()
    {
        var info = new BuildInfo("main", "abc1234", "");
        Assert.False(info.IsTesting);
        Assert.Equal("Vaccine Assist", info.WindowTitle);
    }

    [Fact]
    public void TestingBuildTitleNamesTheSlug()
    {
        var info = new BuildInfo("testing/flu-preferred", "abc1234", "");
        Assert.True(info.IsTesting);
        Assert.Equal("flu-preferred", info.Slug);
        Assert.Equal("Vaccine Assist — TESTING: flu-preferred", info.WindowTitle);
        Assert.Equal("testing", info.Channel);
        Assert.True(info.TrayTooltip.Length <= 63);
        Assert.Contains("TESTING", info.TrayTooltip);
    }

    [Fact]
    public void BareTestingPrefixIsNotATestingBuild()
    {
        Assert.False(new BuildInfo("testing/", "x", "").IsTesting);
    }

    [Fact]
    public void FromAssemblyReadsTheStampOfTheRunningBuild()
    {
        // The test host builds the desktop project without the -p: properties.
        var info = BuildInfo.FromAssembly(typeof(BuildInfo).Assembly);
        Assert.False(info.IsTesting);
    }

    // ---- Version submenu rows ----

    [Fact]
    public void StableRunningChecksStableAndListsTestingBranches()
    {
        var current = new BuildInfo("stable", "abc", "");
        var snap = new TestingVersionsSnapshot(TestingVersionsStatus.Loaded, new[] { "testing/alpha", "testing/flu-preferred" });

        var rows = VersionMenuBuilder.Build(current, snap);

        Assert.Equal(3, rows.Count);
        Assert.Equal("Stable (default)", rows[0].Text);
        Assert.True(rows[0].Checked);
        Assert.Equal("stable", rows[0].Ref);
        Assert.False(rows[1].Checked);
        Assert.Equal("testing/alpha", rows[1].Ref);
        Assert.Equal("Testing — flu-preferred", rows[2].Text);
        Assert.All(rows, r => Assert.True(r.Enabled));
    }

    [Fact]
    public void TestingRunningChecksThatRowAndNotStable()
    {
        var current = new BuildInfo("testing/flu-preferred", "abc", "");
        var snap = new TestingVersionsSnapshot(TestingVersionsStatus.Loaded, new[] { "testing/alpha", "testing/flu-preferred" });

        var rows = VersionMenuBuilder.Build(current, snap);

        Assert.False(rows[0].Checked);
        Assert.Equal(new[] { "testing/flu-preferred" }, rows.Where(r => r.Checked).Select(r => r.Ref).ToArray());
    }

    [Fact]
    public void UnavailableShowsOneDisabledRowAfterStable()
    {
        var rows = VersionMenuBuilder.Build(new BuildInfo("stable", "abc", ""), TestingVersionsSnapshot.Unavailable);

        Assert.Equal(2, rows.Count);
        Assert.Equal("Stable (default)", rows[0].Text);
        Assert.Equal("No testing versions available", rows[1].Text);
        Assert.False(rows[1].Enabled);
        Assert.Null(rows[1].Ref);
    }

    [Fact]
    public void LoadedButEmptyAlsoShowsNoTestingVersions()
    {
        var rows = VersionMenuBuilder.Build(
            new BuildInfo("stable", "abc", ""),
            new TestingVersionsSnapshot(TestingVersionsStatus.Loaded, Array.Empty<string>()));

        Assert.Equal("No testing versions available", rows.Last().Text);
        Assert.False(rows.Last().Enabled);
    }

    [Fact]
    public void LoadingShowsADisabledCheckingRow()
    {
        var rows = VersionMenuBuilder.Build(new BuildInfo("stable", "abc", ""), TestingVersionsSnapshot.Loading);

        Assert.Equal(2, rows.Count);
        Assert.False(rows[1].Enabled);
        Assert.Equal(VersionMenuBuilder.LoadingText, rows[1].Text);
    }

    [Fact]
    public void RunningTestingVersionStaysListedEvenWhenOfflineOrDeleted()
    {
        var rows = VersionMenuBuilder.Build(new BuildInfo("testing/gone", "abc", ""), TestingVersionsSnapshot.Unavailable);

        Assert.Equal(2, rows.Count);
        Assert.Equal("testing/gone", rows[1].Ref);
        Assert.True(rows[1].Checked);
    }

    [Fact]
    public void ConfirmMessageMatchesTheAgreedWording()
    {
        Assert.Equal(
            "Switch to Testing: flu-preferred? Vaccine Assist will restart. The desktop shortcut always opens Stable.",
            VersionMenuBuilder.ConfirmMessage("testing/flu-preferred"));
        Assert.Equal(
            "Switch to Stable? Vaccine Assist will restart. The desktop shortcut always opens Stable.",
            VersionMenuBuilder.ConfirmMessage("stable"));
    }

    // ---- ls-remote parsing ----

    [Fact]
    public void ParsesLsRemoteOutputIntoSortedTestingRefs()
    {
        var output =
            $"{Sha}\trefs/heads/testing/flu-preferred\n" +
            $"{Sha}\trefs/heads/testing/alpha\r\n" +
            "\n" +
            $"{Sha}\trefs/heads/testing/alpha\n"; // duplicate

        Assert.Equal(new[] { "testing/alpha", "testing/flu-preferred" }, TestingBranchParser.ParseLsRemote(output).ToArray());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   \n")]
    [InlineData("garbage line without tab")]
    [InlineData("zzzzzzzzzz\trefs/heads/testing/x")]                 // not a sha
    [InlineData("0124dc7a9b8c\trefs/heads/feature/x")]               // not testing/
    [InlineData("0124dc7a9b8c\trefs/tags/testing/x")]                // tag, not head
    [InlineData("0124dc7a9b8c\trefs/heads/testing/")]                // empty slug
    [InlineData("0124dc7a9b8c\trefs/heads/testing/a b")]             // space splits into 3 parts
    [InlineData("0124dc7a9b8c\trefs/heads/testing/a;rm")]            // injection-ish
    [InlineData("0124dc7a9b8c\trefs/heads/testing/a/b")]             // nested
    [InlineData("0124dc7a9b8c\trefs/heads/testing/-x")]              // leading dash
    [InlineData("0124dc7a9b8c\trefs/heads/testing/a..b")]
    public void IgnoresMalformedOrUnsafeLines(string output)
    {
        Assert.Empty(TestingBranchParser.ParseLsRemote(output));
    }

    [Fact]
    public void NullOutputParsesToEmpty()
    {
        Assert.Empty(TestingBranchParser.ParseLsRemote(null));
    }

    [Theory]
    [InlineData("stable", true)]
    [InlineData("testing/flu-preferred", true)]
    [InlineData("testing/v1.2_rc", true)]
    [InlineData("main", false)]
    [InlineData("testing/", false)]
    [InlineData("testing/a b", false)]
    [InlineData("testing/a\"b", false)]
    [InlineData("--help", false)]
    [InlineData("", false)]
    public void LaunchableRefValidation(string value, bool expected)
    {
        Assert.Equal(expected, TestingBranchParser.IsLaunchableRef(value));
    }

    // ---- launcher command line ----

    [Fact]
    public void LauncherCommandRunsThePrimaryScriptWithRefAndPid()
    {
        var cmd = VersionLauncher.BuildCommand(@"C:\Users\Jane Doe\claude\vaccine-assist", "testing/flu-preferred", 4242);

        Assert.Equal("powershell.exe", cmd.FileName);
        Assert.Equal(
            "-NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\Jane Doe\\claude\\vaccine-assist\\desktop\\update-and-run.ps1\" -Ref \"testing/flu-preferred\" -WaitForPid 4242",
            cmd.Arguments);
        Assert.Equal(@"C:\Users\Jane Doe\claude\vaccine-assist", cmd.WorkingDirectory);
    }

    [Fact]
    public void LauncherCommandToleratesTrailingSlashAndSwitchesBackToStable()
    {
        var cmd = VersionLauncher.BuildCommand(@"C:\va\", "stable", 7);

        Assert.Contains("-File \"C:\\va\\desktop\\update-and-run.ps1\"", cmd.Arguments);
        Assert.Contains("-Ref \"stable\"", cmd.Arguments);
    }

    [Theory]
    [InlineData("main")]
    [InlineData("testing/x\" -Command calc")]
    [InlineData("")]
    public void LauncherCommandRejectsUnsafeRefs(string versionRef)
    {
        Assert.Throws<ArgumentException>(() => VersionLauncher.BuildCommand(@"C:\va", versionRef, 1));
    }

    [Fact]
    public void LauncherCommandRequiresAPrimaryRoot()
    {
        Assert.Throws<ArgumentException>(() => VersionLauncher.BuildCommand("", "stable", 1));
    }

    [Fact]
    public void LsRemoteArgumentsTargetThePrimaryCheckoutWithoutAShell()
    {
        Assert.Equal(
            new[] { "-C", @"C:\va", "ls-remote", "--heads", "origin", "refs/heads/testing/*" },
            GitRemoteLister.BuildArguments(@"C:\va").ToArray());
    }

    // ---- primary checkout location ----

    [Fact]
    public void StampedRootWinsWhenItExists()
    {
        var root = PrimaryCheckoutLocator.Resolve(@"C:\va", @"C:\va-testing\desktop\bin\", _ => true, _ => false);
        Assert.Equal(@"C:\va", root);
    }

    [Fact]
    public void FallsBackToWalkingUpToTheGitRoot()
    {
        var root = PrimaryCheckoutLocator.Resolve(
            "", @"C:\va\desktop\VaccineAssist.Desktop\bin\Debug\net8.0-windows\",
            d => d == @"C:\va", d => d == @"C:\va");
        Assert.Equal(@"C:\va", root);
    }

    [Fact]
    public void TestingWorktreeFolderMapsBackToThePrimaryCheckout()
    {
        var root = PrimaryCheckoutLocator.Resolve(
            "", @"C:\va-testing\desktop\VaccineAssist.Desktop\bin\Debug\net8.0-windows\",
            d => d == @"C:\va" || d == @"C:\va-testing", d => d == @"C:\va-testing");
        Assert.Equal(@"C:\va", root);
    }

    [Fact]
    public void UnresolvableLocationReturnsNull()
    {
        Assert.Null(PrimaryCheckoutLocator.Resolve("", @"C:\nowhere\bin\", _ => false, _ => false));
    }

    // ---- catalog (no process spawned: fake lister) ----

    [Fact]
    public async Task CatalogParsesAndCachesWithinTheTtl()
    {
        var calls = 0;
        var catalog = new TestingVersionCatalog(
            _ => { calls++; return Task.FromResult<string?>($"{Sha}\trefs/heads/testing/alpha\n"); },
            TimeSpan.FromMinutes(5));

        Assert.Equal(TestingVersionsStatus.Loading, catalog.Snapshot.Status);
        var first = await catalog.RefreshAsync();
        var second = await catalog.RefreshAsync();

        Assert.Equal(TestingVersionsStatus.Loaded, first.Status);
        Assert.Equal(new[] { "testing/alpha" }, second.Refs.ToArray());
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task CatalogReportsUnavailableWhenGitFailsOrThrows()
    {
        var nullCatalog = new TestingVersionCatalog(_ => Task.FromResult<string?>(null));
        Assert.Equal(TestingVersionsStatus.Unavailable, (await nullCatalog.RefreshAsync()).Status);

        var throwingCatalog = new TestingVersionCatalog(_ => throw new InvalidOperationException("git exploded"));
        Assert.Equal(TestingVersionsStatus.Unavailable, (await throwingCatalog.RefreshAsync()).Status);
    }

    [Fact]
    public async Task CatalogRetriesAfterAnUnavailableAnswer()
    {
        var calls = 0;
        var catalog = new TestingVersionCatalog(_ =>
        {
            calls++;
            return Task.FromResult<string?>(calls == 1 ? null : $"{Sha}\trefs/heads/testing/b\n");
        });

        Assert.Equal(TestingVersionsStatus.Unavailable, (await catalog.RefreshAsync()).Status);
        Assert.Equal(TestingVersionsStatus.Loaded, (await catalog.RefreshAsync()).Status);
    }

    [Fact]
    public async Task CatalogRefreshDoesNotBlockTheCaller()
    {
        var gate = new TaskCompletionSource<string?>();
        var catalog = new TestingVersionCatalog(_ => gate.Task);

        var pending = catalog.RefreshAsync(); // returns immediately even though git has not answered
        Assert.False(pending.IsCompleted);
        Assert.Equal(TestingVersionsStatus.Loading, catalog.Snapshot.Status);

        gate.SetResult(null);
        Assert.Equal(TestingVersionsStatus.Unavailable, (await pending).Status);
    }
}
