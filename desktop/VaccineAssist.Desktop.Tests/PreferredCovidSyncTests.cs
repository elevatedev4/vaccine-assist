using System;
using System.Collections.Generic;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// The desktop follows the cloud's preferred COVID vaccine but must never block or break:
/// fallback on failure/timeout, the 60 s cache, and tray picks pushed to the cloud.
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
        public int PutCalls => Puts.Count;

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
        public string Local = "pfizer";
        public List<string> Applied { get; } = new();
        public DateTimeOffset Clock = new(2026, 11, 2, 12, 0, 0, TimeSpan.Zero);
        public PreferredCovidSync Sync { get; }

        public Harness(TimeSpan? timeout = null)
        {
            Sync = new PreferredCovidSync(
                Api,
                () => Local,
                adult => { lock (Applied) Applied.Add(adult); Local = adult; },
                () => Clock,
                timeout);
        }

        public void ServerSays(string adult) =>
            Api.OnGet = _ => Task.FromResult<PreferredCovidSetting?>(new PreferredCovidSetting(adult, "moderna"));
    }

    [Fact]
    public async Task AppliesTheCloudValueWhenItDiffers()
    {
        var h = new Harness();
        h.ServerSays("moderna");

        await h.Sync.RefreshIfStaleAsync();

        Assert.Equal(new[] { "moderna" }, h.Applied);
        Assert.Equal("moderna", h.Local);
    }

    [Fact]
    public async Task DoesNothingWhenTheCloudValueMatches()
    {
        var h = new Harness { Local = "Pfizer" }; // case differences are not a change
        h.ServerSays("pfizer");

        await h.Sync.RefreshIfStaleAsync();

        Assert.Empty(h.Applied);
    }

    [Fact]
    public async Task KeepsTheLocalValueWhenTheCloudHasNothingToFollow()
    {
        var h = new Harness { Local = "moderna" };
        h.Api.OnGet = _ => Task.FromResult<PreferredCovidSetting?>(null); // pending:true / unknown value

        await h.Sync.RefreshIfStaleAsync();

        Assert.Empty(h.Applied);
        Assert.Equal("moderna", h.Local);
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task HttpFailuresKeepTheLocalValueAndNeverThrow(HttpStatusCode status)
    {
        var h = new Harness { Local = "moderna" };
        h.Api.OnGet = _ => throw new VaccineApiException(status, "nope");

        await h.Sync.RefreshIfStaleAsync(); // would throw here if it leaked

        Assert.Empty(h.Applied);
        Assert.Equal("moderna", h.Local);
    }

    [Fact]
    public async Task OfflineKeepsTheLocalValueAndNeverThrows()
    {
        var h = new Harness { Local = "moderna" };
        h.Api.OnGet = _ => throw new System.Net.Http.HttpRequestException("offline");

        await h.Sync.RefreshIfStaleAsync();

        Assert.Empty(h.Applied);
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
        Assert.Empty(h.Applied);
        Assert.Equal("pfizer", h.Local);
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

        Assert.Equal(new[] { "moderna" }, h.Applied);
    }

    [Fact]
    public async Task OnlyOneRequestRunsAtATime()
    {
        var h = new Harness();
        var gate = new TaskCompletionSource<PreferredCovidSetting?>();
        h.Api.OnGet = _ => gate.Task;

        var first = h.Sync.RefreshIfStaleAsync();
        var second = h.Sync.RefreshIfStaleAsync();
        gate.SetResult(new PreferredCovidSetting("moderna", "moderna"));
        await Task.WhenAll(first, second);

        Assert.Equal(1, h.Api.GetCalls);
        Assert.Equal(new[] { "moderna" }, h.Applied);
    }

    [Fact]
    public async Task TrayPickIsPushedToTheCloudWithKidsModerna()
    {
        var h = new Harness();

        await h.Sync.PushFromTrayAsync("moderna");

        Assert.Equal(new[] { ("moderna", "moderna") }, h.Api.Puts);
    }

    [Fact]
    public async Task TrayPickNormalizesUnknownValuesToPfizer()
    {
        var h = new Harness();

        await h.Sync.PushFromTrayAsync("something-else");

        Assert.Equal(new[] { ("pfizer", "moderna") }, h.Api.Puts);
    }

    [Fact]
    public async Task AFailedTrayPushNeverThrows()
    {
        var h = new Harness();
        h.Api.OnSet = (_, _) => throw new System.Net.Http.HttpRequestException("offline");

        await h.Sync.PushFromTrayAsync("moderna");

        Assert.Equal(1, h.Api.PutCalls);
    }

    [Fact]
    public async Task AFailedTrayPushIsRetriedBeforeAnyPullSoTheCloudDoesNotUndoThePick()
    {
        var h = new Harness { Local = "moderna" };
        var failFirst = true;
        h.Api.OnSet = (_, _) =>
        {
            if (failFirst) { failFirst = false; throw new System.Net.Http.HttpRequestException("offline"); }
            return Task.FromResult(true);
        };
        h.ServerSays("pfizer"); // the cloud still holds the OLD value

        await h.Sync.PushFromTrayAsync("moderna"); // fails
        h.Clock += PreferredCovidSync.FailureRetryWindow + TimeSpan.FromSeconds(1);
        await h.Sync.RefreshIfStaleAsync();        // retries the push, does not pull

        Assert.Equal(2, h.Api.PutCalls);
        Assert.Equal(0, h.Api.GetCalls);
        Assert.Empty(h.Applied);
        Assert.Equal("moderna", h.Local);

        h.Clock += PreferredCovidSync.CacheWindow + TimeSpan.FromSeconds(1);
        await h.Sync.RefreshIfStaleAsync();         // synced now: pulls again
        Assert.Equal(1, h.Api.GetCalls);
    }

    [Fact]
    public async Task ATrayPickMadeWhileARefreshIsInFlightWinsOverItsOlderAnswer()
    {
        var h = new Harness();
        var gate = new TaskCompletionSource<PreferredCovidSetting?>();
        h.Api.OnGet = _ => gate.Task;

        var refresh = h.Sync.RefreshIfStaleAsync();   // GET is out, cloud will say "moderna"
        var waited = 0;
        while (Volatile.Read(ref h.Api.GetCalls) == 0 && waited++ < 500) await Task.Delay(10);
        Assert.Equal(1, h.Api.GetCalls);
        h.Local = "pfizer";
        await h.Sync.PushFromTrayAsync("pfizer");     // the pharmacist picks Pfizer meanwhile
        gate.SetResult(new PreferredCovidSetting("moderna", "moderna"));
        await refresh;

        Assert.Empty(h.Applied);
        Assert.Equal("pfizer", h.Local);
    }
}
