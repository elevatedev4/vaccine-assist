using System;
using System.Collections.Generic;
using System.Net;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// The desktop follows the cloud's preferred COVID vaccine but must never block or break:
/// fallback on failure/timeout, the 60 s cache, first-run seed/adopt, tray picks pushed to
/// the cloud (and kept across restarts until confirmed).
/// </summary>
public class PreferredCovidSyncTests
{
    private sealed class FakeApi : IPreferredCovidApi
    {
        public Func<CancellationToken, Task<PreferredCovidSetting?>> OnGet { get; set; } =
            _ => Task.FromResult<PreferredCovidSetting?>(null);
        public Func<string, string, Task<bool>> OnSet { get; set; } = (_, _) => Task.FromResult(true);
        public int GetCalls;
        public List<(string Adult, string Kids)> Puts { get; } = new();
        public int PutCalls { get { lock (Puts) return Puts.Count; } }

        public Task<PreferredCovidSetting?> GetPreferredCovidAsync(CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref GetCalls);
            return OnGet(cancellationToken);
        }

        public Task<bool> SetPreferredCovidAsync(string adult, string kids, CancellationToken cancellationToken = default)
        {
            lock (Puts) Puts.Add((adult, kids));
            return OnSet(adult, kids);
        }
    }

    private sealed class Harness
    {
        public FakeApi Api { get; } = new();
        public AppSettings Settings { get; }
        public int StateChangedCalls;
        /// <summary>PreferredCovidAdult as it was at each stateChanged callback (what the tray check is set from).</summary>
        public List<string> AdultAtCallback { get; } = new();
        public DateTimeOffset Clock = new(2026, 11, 2, 12, 0, 0, TimeSpan.Zero);
        public PreferredCovidSync Sync { get; }

        public Harness(string local = "pfizer", bool synced = true, string? unsynced = null, TimeSpan? timeout = null)
        {
            Settings = new AppSettings
            {
                PreferredCovidAdult = local,
                PreferredCovidSynced = synced,
                PreferredCovidUnsyncedAdult = unsynced,
            };
            Sync = new PreferredCovidSync(Api, Settings, OnChanged, () => Clock, timeout);
        }

        private void OnChanged()
        {
            Interlocked.Increment(ref StateChangedCalls);
            lock (AdultAtCallback) AdultAtCallback.Add(Settings.PreferredCovidAdult);
        }

        public void ServerSays(string adult, bool saved = true) =>
            Api.OnGet = _ => Task.FromResult<PreferredCovidSetting?>(new PreferredCovidSetting(adult, "moderna", saved));

        public async Task WaitForGetAsync()
        {
            var waited = 0;
            while (Volatile.Read(ref Api.GetCalls) == 0 && waited++ < 500) await Task.Delay(10);
            Assert.True(Api.GetCalls >= 1);
        }
    }

    // ---- follow the cloud (after the first sync) ----

    [Fact]
    public async Task AppliesTheCloudValueWhenItDiffers()
    {
        var h = new Harness();
        h.ServerSays("moderna");

        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
        Assert.Equal(1, h.StateChangedCalls);
        Assert.Equal(new[] { "moderna" }, h.AdultAtCallback); // tray check reads the current setting
        Assert.Equal(0, h.Api.PutCalls);
    }

    [Fact]
    public async Task DoesNothingWhenTheCloudValueMatches()
    {
        var h = new Harness(local: "Pfizer"); // case differences are not a change
        h.ServerSays("pfizer");

        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal("Pfizer", h.Settings.PreferredCovidAdult);
        Assert.Equal(0, h.StateChangedCalls);
    }

    [Fact]
    public async Task KeepsTheLocalValueWhenTheCloudHasNothingToFollow()
    {
        var h = new Harness(local: "moderna", synced: false);
        h.Api.OnGet = _ => Task.FromResult<PreferredCovidSetting?>(null); // pending:true / unknown value

        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
        Assert.False(h.Settings.PreferredCovidSynced);
        Assert.Equal(0, h.Api.PutCalls);
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task HttpFailuresKeepTheLocalValueAndNeverThrow(HttpStatusCode status)
    {
        var h = new Harness(local: "moderna");
        h.Api.OnGet = _ => throw new VaccineApiException(status, "nope");

        await h.Sync.RefreshIfStaleAsync(); // would throw here if it leaked

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
        Assert.Equal(0, h.StateChangedCalls);
    }

    [Fact]
    public async Task OfflineKeepsTheLocalValueAndNeverThrows()
    {
        var h = new Harness(local: "moderna");
        h.Api.OnGet = _ => throw new System.Net.Http.HttpRequestException("offline");

        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
    }

    [Fact]
    public async Task ACallThatNeverReturnsTimesOutAndKeepsTheLocalValue()
    {
        var h = new Harness(timeout: TimeSpan.FromMilliseconds(150));
        // Ignores its token, like a hung socket would - the hard wait must still end it.
        h.Api.OnGet = _ => new TaskCompletionSource<PreferredCovidSetting?>().Task;

        var refresh = h.Sync.RefreshIfStaleAsync();
        var finished = await Task.WhenAny(refresh, Task.Delay(TimeSpan.FromSeconds(10)));

        Assert.Same(refresh, finished);
        Assert.Equal("pfizer", h.Settings.PreferredCovidAdult);
    }

    [Fact]
    public void TheRequestTimeoutIsAtMostThreeSeconds()
    {
        Assert.True(PreferredCovidSync.RequestTimeout <= TimeSpan.FromSeconds(3));
    }

    [Fact]
    public async Task AFreshAnswerIsCachedForTheCacheWindow()
    {
        var h = new Harness();
        h.ServerSays("pfizer");

        await h.Sync.RefreshIfStaleAsync();
        h.Clock += PreferredCovidSync.CacheWindow - TimeSpan.FromSeconds(1);
        await h.Sync.RefreshIfStaleAsync();
        await h.Sync.RefreshIfStaleAsync();
        Assert.Equal(1, h.Api.GetCalls);

        h.Clock += TimeSpan.FromSeconds(2); // now past the window
        await h.Sync.RefreshIfStaleAsync();
        Assert.Equal(2, h.Api.GetCalls);
    }

    [Fact]
    public void TheCacheWindowIsAboutSixtySeconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(60), PreferredCovidSync.CacheWindow);
    }

    [Fact]
    public async Task AFailedAttemptIsNotRetriedOnEveryKeypressButSoonAfter()
    {
        var h = new Harness();
        h.Api.OnGet = _ => throw new VaccineApiException(HttpStatusCode.Unauthorized, "not signed in");

        await h.Sync.RefreshIfStaleAsync();
        await h.Sync.RefreshIfStaleAsync();
        await h.Sync.RefreshIfStaleAsync();
        Assert.Equal(1, h.Api.GetCalls);

        h.Clock += PreferredCovidSync.FailureRetryWindow + TimeSpan.FromSeconds(1);
        h.ServerSays("moderna");
        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
    }

    [Fact]
    public async Task OnlyOneRequestRunsAtATime()
    {
        var h = new Harness();
        var gate = new TaskCompletionSource<PreferredCovidSetting?>();
        h.Api.OnGet = _ => gate.Task;

        var first = h.Sync.RefreshIfStaleAsync();
        var second = h.Sync.RefreshIfStaleAsync();
        gate.SetResult(new PreferredCovidSetting("moderna", "moderna", true));
        await Task.WhenAll(first, second);

        Assert.Equal(1, h.Api.GetCalls);
        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
    }

    // ---- first run: seed or adopt ----

    [Fact]
    public async Task FirstRunSeedsTheCloudWhenItReportsNothingSaved()
    {
        var h = new Harness(local: "moderna", synced: false);
        h.ServerSays("pfizer", saved: false); // the cloud's never-saved default

        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);          // local choice NOT flipped
        Assert.Equal(new[] { ("moderna", "moderna") }, h.Api.Puts);       // cloud seeded with it
        Assert.True(h.Settings.PreferredCovidSynced);
        Assert.Null(h.Settings.PreferredCovidUnsyncedAdult);
    }

    [Fact]
    public async Task FirstRunAgainstAnOlderCloudWithoutTheSavedFieldAlsoSeeds()
    {
        // An older cloud's GET has no "saved" key: the record's Saved defaults to false.
        var h = new Harness(local: "moderna", synced: false);
        h.Api.OnGet = _ => Task.FromResult<PreferredCovidSetting?>(new PreferredCovidSetting("pfizer", "moderna"));

        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
        Assert.Equal(new[] { ("moderna", "moderna") }, h.Api.Puts);
        Assert.True(h.Settings.PreferredCovidSynced);
    }

    [Fact]
    public async Task FirstRunAdoptsTheCloudValueWhenItReportsASavedOne()
    {
        var h = new Harness(local: "pfizer", synced: false);
        h.ServerSays("moderna", saved: true);

        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
        Assert.True(h.Settings.PreferredCovidSynced);
        Assert.Equal(0, h.Api.PutCalls);
        Assert.Equal(new[] { "moderna" }, h.AdultAtCallback);
    }

    [Fact]
    public async Task FirstRunWithASavedValueEqualToLocalJustMarksItSynced()
    {
        var h = new Harness(local: "pfizer", synced: false);
        h.ServerSays("pfizer", saved: true);

        await h.Sync.RefreshIfStaleAsync();

        Assert.True(h.Settings.PreferredCovidSynced);
        Assert.Equal(0, h.Api.PutCalls);
        Assert.Equal(1, h.StateChangedCalls); // flag persisted
    }

    [Fact]
    public async Task AfterTheFirstSyncTheCloudAlwaysWins()
    {
        var h = new Harness(local: "moderna", synced: true);
        h.ServerSays("pfizer", saved: false);

        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal("pfizer", h.Settings.PreferredCovidAdult);
        Assert.Equal(0, h.Api.PutCalls);
    }

    [Fact]
    public async Task AFailedSeedStaysUnsyncedAndIsRetried()
    {
        var h = new Harness(local: "moderna", synced: false);
        h.ServerSays("pfizer", saved: false);
        var fail = true;
        h.Api.OnSet = (_, _) =>
        {
            if (fail) throw new System.Net.Http.HttpRequestException("offline");
            return Task.FromResult(true);
        };

        await h.Sync.RefreshIfStaleAsync();
        Assert.False(h.Settings.PreferredCovidSynced);
        Assert.Equal("moderna", h.Settings.PreferredCovidUnsyncedAdult);

        fail = false;
        h.Clock += PreferredCovidSync.FailureRetryWindow + TimeSpan.FromSeconds(1);
        await h.Sync.RefreshIfStaleAsync();

        Assert.True(h.Settings.PreferredCovidSynced);
        Assert.Null(h.Settings.PreferredCovidUnsyncedAdult);
        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
    }

    // ---- tray picks ----

    [Fact]
    public async Task TrayPickIsPushedToTheCloudWithKidsModerna()
    {
        var h = new Harness();

        h.Sync.MarkLocalPick("moderna");
        await h.Sync.PushPendingAsync();

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
        Assert.Equal(new[] { ("moderna", "moderna") }, h.Api.Puts);
        Assert.Null(h.Settings.PreferredCovidUnsyncedAdult);
        Assert.True(h.Settings.PreferredCovidSynced);
    }

    [Fact]
    public async Task TrayPickNormalizesUnknownValuesToPfizer()
    {
        var h = new Harness(local: "moderna");

        h.Sync.MarkLocalPick("something-else");
        await h.Sync.PushPendingAsync();

        Assert.Equal("pfizer", h.Settings.PreferredCovidAdult);
        Assert.Equal(new[] { ("pfizer", "moderna") }, h.Api.Puts);
    }

    [Fact]
    public async Task AFailedTrayPushNeverThrowsAndKeepsThePickUnsynced()
    {
        var h = new Harness();
        h.Api.OnSet = (_, _) => throw new System.Net.Http.HttpRequestException("offline");

        h.Sync.MarkLocalPick("moderna");
        await h.Sync.PushPendingAsync();

        Assert.Equal(1, h.Api.PutCalls);
        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
        Assert.Equal("moderna", h.Settings.PreferredCovidUnsyncedAdult);
    }

    [Fact]
    public async Task AFailedTrayPushIsRetriedBeforeAnyPullSoTheCloudDoesNotUndoThePick()
    {
        var h = new Harness(local: "pfizer");
        var failFirst = true;
        h.Api.OnSet = (_, _) =>
        {
            if (failFirst) { failFirst = false; throw new System.Net.Http.HttpRequestException("offline"); }
            return Task.FromResult(true);
        };
        h.ServerSays("pfizer"); // the cloud still holds the OLD value

        h.Sync.MarkLocalPick("moderna");
        await h.Sync.PushPendingAsync();                 // fails
        h.Clock += PreferredCovidSync.FailureRetryWindow + TimeSpan.FromSeconds(1);
        await h.Sync.RefreshIfStaleAsync();              // retries the push, does not pull

        Assert.Equal(2, h.Api.PutCalls);
        Assert.Equal(0, h.Api.GetCalls);
        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
        Assert.Null(h.Settings.PreferredCovidUnsyncedAdult);

        h.Clock += PreferredCovidSync.CacheWindow + TimeSpan.FromSeconds(1);
        await h.Sync.RefreshIfStaleAsync();              // confirmed now: pulls again
        Assert.Equal(1, h.Api.GetCalls);
    }

    [Fact]
    public async Task APushTheCloudAnswersPendingIsNotConfirmedAndKeepsRetrying()
    {
        var h = new Harness(local: "pfizer", synced: false);
        h.Api.OnSet = (_, _) => Task.FromResult(false); // {pending:true}: setting table not created yet
        h.ServerSays("pfizer", saved: false);

        h.Sync.MarkLocalPick("moderna");
        await h.Sync.PushPendingAsync();

        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);              // local kept
        Assert.Equal("moderna", h.Settings.PreferredCovidUnsyncedAdult);      // still waiting
        Assert.False(h.Settings.PreferredCovidSynced);

        h.Clock += PreferredCovidSync.FailureRetryWindow + TimeSpan.FromSeconds(1);
        await h.Sync.RefreshIfStaleAsync();                                    // retries the PUT, never pulls

        Assert.Equal(2, h.Api.PutCalls);
        Assert.Equal(0, h.Api.GetCalls);
        Assert.Equal("moderna", h.Settings.PreferredCovidAdult);
        Assert.False(h.Settings.PreferredCovidSynced);
    }

    [Fact]
    public async Task AnUnsyncedPickSurvivesARestartAndIsPushedBeforeAnyPull()
    {
        // Session 1: pick Moderna while offline, settings.json written.
        var first = new Harness(local: "pfizer", synced: true);
        first.Api.OnSet = (_, _) => throw new System.Net.Http.HttpRequestException("offline");
        first.Sync.MarkLocalPick("moderna");
        await first.Sync.PushPendingAsync();
        var json = JsonSerializer.Serialize(first.Settings);

        // Session 2: settings.json loaded back, new sync object.
        var reloaded = JsonSerializer.Deserialize<AppSettings>(json)!;
        Assert.Equal("moderna", reloaded.PreferredCovidUnsyncedAdult);
        var api = new FakeApi();
        api.OnGet = _ => Task.FromResult<PreferredCovidSetting?>(new PreferredCovidSetting("pfizer", "moderna", true));
        var sync = new PreferredCovidSync(api, reloaded, () => { }, () => first.Clock);

        await sync.RefreshIfStaleAsync();

        Assert.Equal(new[] { ("moderna", "moderna") }, api.Puts);
        Assert.Equal(0, api.GetCalls);
        Assert.Equal("moderna", reloaded.PreferredCovidAdult);
        Assert.Null(reloaded.PreferredCovidUnsyncedAdult);
    }

    [Fact]
    public void TheSyncStateSurvivesASettingsJsonRoundTrip()
    {
        var settings = new AppSettings { PreferredCovidSynced = true, PreferredCovidUnsyncedAdult = "moderna" };

        var back = JsonSerializer.Deserialize<AppSettings>(JsonSerializer.Serialize(settings))!;

        Assert.True(back.PreferredCovidSynced);
        Assert.Equal("moderna", back.PreferredCovidUnsyncedAdult);
        Assert.False(new AppSettings().PreferredCovidSynced);
        Assert.Null(new AppSettings().PreferredCovidUnsyncedAdult);
    }

    // ---- races ----

    [Fact]
    public async Task ATrayPickMadeWhileARefreshIsInFlightIsNotOverwrittenEvenBeforeItsPush()
    {
        // The reviewer's race: the pick is recorded (before any PUT), then the older GET lands.
        var h = new Harness(local: "pfizer");
        var gate = new TaskCompletionSource<PreferredCovidSetting?>();
        h.Api.OnGet = _ => gate.Task;

        var refresh = h.Sync.RefreshIfStaleAsync();   // GET is out, cloud will say "moderna"
        await h.WaitForGetAsync();
        h.Sync.MarkLocalPick("pfizer");               // pick recorded; PushPendingAsync NOT called yet
        gate.SetResult(new PreferredCovidSetting("moderna", "moderna", true));
        await refresh;

        Assert.Equal("pfizer", h.Settings.PreferredCovidAdult);
        Assert.Equal("pfizer", h.Settings.PreferredCovidUnsyncedAdult);
        Assert.Equal(0, h.StateChangedCalls);
    }

    [Fact]
    public async Task TheNewestPickIsTheOneThatReachesTheCloud()
    {
        var h = new Harness();
        var release = new TaskCompletionSource<bool>();
        var first = true;
        h.Api.OnSet = (_, _) =>
        {
            if (first) { first = false; return release.Task; }
            return Task.FromResult(true);
        };

        h.Sync.MarkLocalPick("moderna");
        var push1 = h.Sync.PushPendingAsync();         // PUT moderna held open
        h.Sync.MarkLocalPick("pfizer");                // changed mind
        var push2 = h.Sync.PushPendingAsync();         // queued behind push1
        release.SetResult(true);
        await Task.WhenAll(push1, push2);

        Assert.Equal("pfizer", h.Api.Puts[^1].Adult);  // last write to the cloud is the newest pick
        Assert.Equal("pfizer", h.Settings.PreferredCovidAdult);
        Assert.Null(h.Settings.PreferredCovidUnsyncedAdult);
    }
}
