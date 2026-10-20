using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Overlay;
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
    [InlineData("testing/x\n", false)]       // trailing newline must not slip past the end anchor
    [InlineData("stable\n", false)]
    [InlineData("testing/aux", false)]       // Windows device names cannot be ref files
    [InlineData("testing/CON", false)]
    [InlineData("testing/com1", false)]
    [InlineData("testing/lpt9.txt", false)]
    [InlineData("testing/console", true)]
    public void LaunchableRefValidation(string value, bool expected)
    {
        Assert.Equal(expected, TestingBranchParser.IsLaunchableRef(value));
    }

    [Fact]
    public void LsRemoteLinesWithReservedOrNewlineNamesAreDropped()
    {
        var output = $"{Sha}\trefs/heads/testing/aux\n{Sha}\trefs/heads/testing/ok\n";
        Assert.Equal(new[] { "testing/ok" }, TestingBranchParser.ParseLsRemote(output).ToArray());
    }

    [Theory]
    [InlineData(10, 10)]
    [InlineData(63, 63)]
    [InlineData(64, 63)]
    [InlineData(200, 63)]
    public void TrayTooltipIsClampedToTheNotifyIconLimit(int length, int expected)
    {
        Assert.Equal(expected, BuildInfo.ClampTooltip(new string('x', length)).Length);
    }

    [Fact]
    public void LongestFaxTooltipStaysWithinTheLimitAfterClamping()
    {
        var info = new BuildInfo("testing/" + new string('a', 60), "abc", "");
        var text = $"{info.TrayTooltip} \u2014 Faxes: 123456 in process";
        Assert.True(BuildInfo.ClampTooltip(text).Length <= 63);
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

    // ---- no silent path: the switch decision ----

    private const string Root = @"C:\va";

    private static BuildInfo StableBuild => new("stable", "abc1234", Root);
    private static BuildInfo TestingBuild => new("testing/flu-preferred", "abc1234", Root);

    [Fact]
    public void StableBuildMayProceedToATestingVersion()
    {
        var plan = VersionSwitchPlanner.Evaluate(StableBuild, "testing/flu-preferred", Root, entryBusy: false);
        Assert.Equal(VersionSwitchOutcome.Proceed, plan.Outcome);
        Assert.Null(plan.Message);
    }

    [Fact]
    public void TestingBuildCanSwitchBackToStableThroughTheSameMenu()
    {
        // The row exists, is enabled and carries the ref the launcher accepts...
        var rows = VersionMenuBuilder.Build(
            TestingBuild,
            new TestingVersionsSnapshot(TestingVersionsStatus.Loaded, new[] { "testing/flu-preferred" }));
        var stableRow = rows.Single(r => r.Ref == BuildInfo.StableRef);
        Assert.True(stableRow.Enabled);
        Assert.False(stableRow.Checked);
        Assert.True(TestingBranchParser.IsLaunchableRef(stableRow.Ref));

        // ...the planner lets it through, and the launcher builds a command for it.
        var plan = VersionSwitchPlanner.Evaluate(TestingBuild, stableRow.Ref, Root, entryBusy: false);
        Assert.Equal(VersionSwitchOutcome.Proceed, plan.Outcome);
        var cmd = VersionLauncher.BuildCommand(Root, stableRow.Ref!, 99);
        Assert.Contains("-Ref \"stable\"", cmd.Arguments);
    }

    [Fact]
    public void TestingBuildCanSwitchToAnotherTestingVersion()
    {
        var plan = VersionSwitchPlanner.Evaluate(TestingBuild, "testing/other", Root, entryBusy: false);
        Assert.Equal(VersionSwitchOutcome.Proceed, plan.Outcome);
    }

    public static TheoryData<string?, string?, bool, VersionSwitchOutcome> RefusedSwitches => new()
    {
        { "stable", Root, false, VersionSwitchOutcome.AlreadyRunning },
        { "main", Root, false, VersionSwitchOutcome.InvalidRef },
        { null, Root, false, VersionSwitchOutcome.InvalidRef },
        { "", Root, false, VersionSwitchOutcome.InvalidRef },
        { "testing/flu-preferred", Root, true, VersionSwitchOutcome.EntryBusy },
        { "testing/flu-preferred", null, false, VersionSwitchOutcome.CheckoutNotFound },
        { "testing/flu-preferred", "  ", false, VersionSwitchOutcome.CheckoutNotFound },
    };

    [Theory]
    [MemberData(nameof(RefusedSwitches))]
    public void EveryRefusalExplainsItselfInPlainWords(string? requestedRef, string? root, bool busy, VersionSwitchOutcome expected)
    {
        var plan = VersionSwitchPlanner.Evaluate(StableBuild, requestedRef, root, busy);

        Assert.Equal(expected, plan.Outcome);
        Assert.False(string.IsNullOrWhiteSpace(plan.Message));
    }

    [Fact]
    public void RunningTestingVersionClickedAgainSaysSo()
    {
        var plan = VersionSwitchPlanner.Evaluate(TestingBuild, "testing/flu-preferred", Root, entryBusy: false);

        Assert.Equal(VersionSwitchOutcome.AlreadyRunning, plan.Outcome);
        Assert.Contains("Testing: flu-preferred", plan.Message);
    }

    [Fact]
    public void EveryOutcomeOtherThanProceedIsCoveredByARefusalCase()
    {
        var covered = RefusedSwitches.Select(r => (VersionSwitchOutcome)r[3]).ToHashSet();
        foreach (var outcome in Enum.GetValues<VersionSwitchOutcome>().Where(o => o != VersionSwitchOutcome.Proceed))
        {
            Assert.Contains(outcome, covered);
        }
    }

    [Fact]
    public void EveryRefListedInTheMenuIsAcceptedByThePlanner()
    {
        // The menu only lists refs the parser accepts; the click path must never reject one of them as "invalid".
        var snap = new TestingVersionsSnapshot(
            TestingVersionsStatus.Loaded,
            TestingBranchParser.ParseLsRemote($"{Sha}\trefs/heads/testing/flu-preferred\n{Sha}\trefs/heads/testing/v1.2_rc\n"));

        foreach (var row in VersionMenuBuilder.Build(StableBuild, snap).Where(r => r.Ref is not null && r.Ref != "stable"))
        {
            Assert.Equal(VersionSwitchOutcome.Proceed, VersionSwitchPlanner.Evaluate(StableBuild, row.Ref, Root, false).Outcome);
        }
    }

    [Fact]
    public void VersionMessageBoxesAlwaysOpenInFrontOfEverything()
    {
        Assert.NotEqual(0u, VersionDialogs.NoticeFlags & VersionDialogs.MB_TOPMOST);
        Assert.NotEqual(0u, VersionDialogs.NoticeFlags & VersionDialogs.MB_SETFOREGROUND);
        Assert.NotEqual(0u, VersionDialogs.ConfirmFlags & VersionDialogs.MB_TOPMOST);
        Assert.NotEqual(0u, VersionDialogs.ConfirmFlags & VersionDialogs.MB_SETFOREGROUND);
    }

    // ---- repainting an open submenu ----

    [Fact]
    public void SignatureIsStableForIdenticalRowsAndChangesWhenRowsChange()
    {
        var loading = VersionMenuBuilder.Build(StableBuild, TestingVersionsSnapshot.Loading);
        var loadingAgain = VersionMenuBuilder.Build(StableBuild, TestingVersionsSnapshot.Loading);
        var loaded = VersionMenuBuilder.Build(
            StableBuild, new TestingVersionsSnapshot(TestingVersionsStatus.Loaded, new[] { "testing/alpha" }));

        Assert.Equal(VersionMenuBuilder.Signature(loading), VersionMenuBuilder.Signature(loadingAgain));
        Assert.NotEqual(VersionMenuBuilder.Signature(loading), VersionMenuBuilder.Signature(loaded));
    }

    // ---- overlay outside-click hook (root cause: menu closed on mouse-down before the row's Click) ----

    private static readonly OverlayRect MainMenu = new(100, 200, 150, 300);
    private static readonly OverlayRect SubMenu = new(250, 400, 180, 90);

    [Fact]
    public void ClickOnAVersionRowOutsideTheMainMenuDoesNotCloseTheMenu()
    {
        Assert.False(OverlayMenuGeometry.ShouldCloseOnOutsideClick(MainMenu, submenuOpen: true, SubMenu, x: 300, y: 430));
    }

    [Fact]
    public void ClickOnAVersionRowWithUnknownSubmenuBoundsDoesNotCloseTheMenu()
    {
        Assert.False(OverlayMenuGeometry.ShouldCloseOnOutsideClick(MainMenu, submenuOpen: true, submenuBounds: null, x: 300, y: 430));
    }

    [Fact]
    public void ClickAwayFromBothMenusStillClosesIt()
    {
        Assert.True(OverlayMenuGeometry.ShouldCloseOnOutsideClick(MainMenu, submenuOpen: true, SubMenu, x: 900, y: 900));
        Assert.True(OverlayMenuGeometry.ShouldCloseOnOutsideClick(MainMenu, submenuOpen: false, null, x: 900, y: 900));
    }

    [Fact]
    public void ClickInsideTheMainMenuNeverClosesIt()
    {
        Assert.False(OverlayMenuGeometry.ShouldCloseOnOutsideClick(MainMenu, submenuOpen: false, null, x: 150, y: 250));
    }

    [Fact]
    public void SubmenuAreaCountsAsOutsideWhenTheSubmenuIsNotOpen()
    {
        Assert.True(OverlayMenuGeometry.ShouldCloseOnOutsideClick(MainMenu, submenuOpen: false, SubMenu, x: 300, y: 430));
    }
}
